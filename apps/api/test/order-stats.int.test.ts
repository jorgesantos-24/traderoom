import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { OrderStatsQuery, ListOrderHistoryQuery } from '@traderoom/shared';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/lib/db.js';
import { createOrderStatsService, type OrderStatsService } from '../src/services/order-stats.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const DOMAIN = 'order-stats-int.traderoom.test';
const SYMBOL = 'ZZSTATUSDT';

let pool: pg.Pool;
let assetId: number;
let svc: OrderStatsService;
let user: string;

async function order(status: string, stakeCents: number, opensAt: string, account = 'real'): Promise<void> {
  await pool.query(
    `insert into orders (user_id, account, asset_id, direction, stake_cents, payout_pct, duration_sec, open_price, status,
                         opens_at, expires_at, idempotency_key)
     values ($1, $2, $3, 'call', $4, 85, 60, 1, $5, $6, $6::timestamptz + interval '1 minute', $7)`,
    [user, account, assetId, stakeCents, status, opensAt, `k-${randomUUID()}`],
  );
}

beforeAll(async () => {
  pool = createPool(config);
  const { rows } = await pool.query<{ id: number }>(
    `insert into assets (symbol, display, binance_stream, payout_pct, enabled, sort)
     values ($1, 'ZZSTAT/USD', $2, 85, true, 9997)
     on conflict (symbol) do update set enabled = true returning id`,
    [SYMBOL, `${SYMBOL.toLowerCase()}@bookTicker`],
  );
  assetId = rows[0]?.id ?? 0;
  const u = await pool.query<{ id: string }>(`insert into users (email, password_hash, name) values ($1, '!', 'Stats') returning id`, [
    `u-${randomUUID()}@${DOMAIN}`,
  ]);
  user = u.rows[0]?.id ?? '';
  svc = createOrderStatsService(pool);

  // São Paulo is UTC-3: 02:00Z on the 10th is still the 9th there.
  await order('won', 10_000, '2026-11-09T12:00:00Z'); // +85,00
  await order('lost', 2_000, '2026-11-09T13:00:00Z'); // -20,00
  await order('void', 5_000, '2026-11-10T02:00:00Z'); // 0, day 9 in São Paulo
  await order('won', 333, '2026-11-10T15:00:00Z'); // +2,83 (floors)
  await order('open', 50_000, '2026-11-10T16:00:00Z'); // not settled: left out
  await order('won', 99_999, '2026-11-10T16:00:00Z', 'demo'); // other account
  await order('lost', 7_000, '2026-11-20T10:00:00Z'); // outside the range
});

afterAll(async () => {
  await pool.query(`delete from orders where user_id = $1`, [user]);
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`]);
  await pool.query('delete from assets where id = $1', [assetId]);
  await pool.end();
});

const range = { from: '2026-11-09T03:00:00Z', to: '2026-11-11T03:00:00Z', tz: 'America/Sao_Paulo' };

describe('order stats', () => {
  it('sums settled orders of one account in the period, by local day', async () => {
    const s = await svc.stats(user, OrderStatsQuery.parse(range));
    expect(s).toMatchObject({
      total: 4,
      won: 2,
      lost: 1,
      void: 1,
      profitCents: 8_500 - 2_000 + 283,
      bestCents: 8_500,
      worstCents: -2_000,
      winRatePct: 66.7,
      volumeCents: 17_333,
      maxStakeCents: 10_000,
      minStakeCents: 333,
    });
    expect(s.daily).toEqual([
      { day: '2026-11-09', netCents: 6_500, cumulativeCents: 6_500, orders: 3 },
      { day: '2026-11-10', netCents: 283, cumulativeCents: 6_783, orders: 1 },
    ]);
  });

  it('filters by result and returns empty stats for an empty period', async () => {
    const lost = await svc.stats(user, OrderStatsQuery.parse({ ...range, result: 'lost' }));
    expect(lost).toMatchObject({ total: 1, profitCents: -2_000, winRatePct: 0 });

    const none = await svc.stats(user, OrderStatsQuery.parse({ ...range, from: '2025-01-01T00:00:00Z', to: '2025-01-02T00:00:00Z' }));
    expect(none).toMatchObject({ total: 0, profitCents: 0, bestCents: null, winRatePct: null, maxStakeCents: null, daily: [] });
  });

  it('pages the settled orders of the period, newest first', async () => {
    const p1 = await svc.history(user, ListOrderHistoryQuery.parse({ ...range, limit: 3 }));
    expect(p1.items.map((o) => o.stakeCents)).toEqual([333, 5_000, 2_000]);
    const p2 = await svc.history(user, ListOrderHistoryQuery.parse({ ...range, limit: 3, cursor: p1.nextCursor }));
    expect(p2.items.map((o) => o.stakeCents)).toEqual([10_000]);
    expect(p2.nextCursor).toBeNull();
  });

  it('rejects a bad zone or an inverted range', async () => {
    await expect(svc.stats(user, OrderStatsQuery.parse({ ...range, tz: 'Mars/Olympus' }))).rejects.toThrow(/fuso/);
    expect(() => OrderStatsQuery.parse({ ...range, from: range.to, to: range.from })).toThrow();
  });
});
