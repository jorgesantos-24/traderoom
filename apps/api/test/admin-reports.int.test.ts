// Requires `npm run dev:deps` and `npm run db:migrate` first.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/lib/db.js';
import { createAdminReportsService, type AdminReportsService } from '../src/services/admin-reports.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const DOMAIN = 'reports-int.traderoom.test';
const SYMBOL = 'ZZREPUSDT';
const TZ = 'America/Sao_Paulo';

let pool: pg.Pool;
let svc: AdminReportsService;
let assetId: number;
let k = 0;

async function newUser(name: string, role: 'user' | 'admin' = 'user'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(`insert into users (email, password_hash, name, role) values ($1, '!', $2, $3) returning id`, [
    `${name.toLowerCase()}-${randomUUID()}@${DOMAIN}`,
    name,
    role,
  ]);
  return rows[0]!.id;
}

async function order(user: string, status: 'open' | 'won' | 'lost', stake: number, account: 'real' | 'demo' = 'real'): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into orders (user_id, asset_id, direction, stake_cents, payout_pct, duration_sec, open_price, status, expires_at, idempotency_key, account)
     values ($1, $2, 'call', $3, 85, 60, 1, $4, now() + interval '1 minute', $5, $6) returning id`,
    [user, assetId, stake, status, `rep-${randomUUID()}-${k++}`, account],
  );
  const id = rows[0]!.id;
  await pool.query(`insert into ledger (user_id, order_id, delta_cents, balance_after, kind, account) values ($1, $2, $3, 0, 'stake', $4)`, [
    user,
    id,
    -stake,
    account,
  ]);
  if (status === 'won') {
    await pool.query(`insert into ledger (user_id, order_id, delta_cents, balance_after, kind, account) values ($1, $2, $3, 0, 'payout', $4)`, [
      user,
      id,
      stake + Math.floor((stake * 85) / 100),
      account,
    ]);
  }
}

beforeAll(async () => {
  pool = createPool(config);
  svc = createAdminReportsService(pool);
  const { rows } = await pool.query<{ id: number }>(
    `insert into assets (symbol, display, binance_stream, payout_pct, enabled, sort)
     values ($1, 'ZZREP/USD', 'zzrepusdt@bookTicker', 85, false, 9996)
     on conflict (symbol) do update set payout_pct = 85 returning id`,
    [SYMBOL],
  );
  assetId = rows[0]!.id;
});

afterAll(async () => {
  const users = `select id from users where email like '%@${DOMAIN}'`;
  await pool.query(`delete from ledger where user_id in (${users})`);
  await pool.query(`delete from orders where user_id in (${users})`);
  await pool.query(`delete from deposits where user_id in (${users})`);
  await pool.query(`delete from withdrawals where user_id in (${users})`);
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`]);
  await pool.query('delete from assets where id = $1', [assetId]);
  await pool.end();
});

describe('admin reports', () => {
  it('house result counts real client orders only: kept stakes minus paid profit', async () => {
    const before = await svc.results(TZ);
    const ana = await newUser('Ana');
    const bruno = await newUser('Bruno');
    const admin = await newUser('Admin', 'admin');
    await order(ana, 'won', 1000); // house pays 850
    await order(ana, 'won', 333); // house pays 283
    await order(bruno, 'lost', 500); // house keeps 500
    await order(bruno, 'open', 200); // at risk: 170
    await order(bruno, 'lost', 9999, 'demo'); // demo: ignored
    await order(admin, 'lost', 7777); // admin: ignored
    await pool.query(`insert into deposits (user_id, amount_cents, status, credited_cents, paid_at) values ($1, 5000, 'paid', 900, now())`, [ana]);
    await pool.query(
      `insert into withdrawals (user_id, amount_cents, pix_amount_cents, fx_rate, pix_key, pix_key_type, status, completed_at)
       values ($1, 300, 1650, 5.5, 'x', 'EMAIL', 'completed', now())`,
      [bruno],
    );

    const after = await svc.results(TZ);
    for (const key of ['today', 'week', 'month'] as const) {
      const a = after[key];
      const b = before[key];
      expect(a.entries - b.entries).toBe(4);
      expect(a.won - b.won).toBe(2);
      expect(a.lost - b.lost).toBe(1);
      expect(a.open - b.open).toBe(1);
      expect(a.volumeCents - b.volumeCents).toBe(2033);
      expect(a.collectedCents - b.collectedCents).toBe(500);
      expect(a.paidCents - b.paidCents).toBe(1133);
      expect(a.houseCents - b.houseCents).toBe(-633);
      expect(a.depositsCents - b.depositsCents).toBe(900);
      expect(a.withdrawalsCents - b.withdrawalsCents).toBe(300);
    }
    expect(after.openNow.maxPayoutCents - before.openNow.maxPayoutCents).toBe(170);
    expect(after.daily).toHaveLength(30);
    expect(after.daily.at(-1)!.houseCents - before.daily.at(-1)!.houseCents).toBe(-633);
    expect(after.topWinners.find((c) => c.userId === ana)).toMatchObject({ entries: 2, netCents: 1133 });
    expect(after.topLosers.find((c) => c.userId === bruno)).toMatchObject({ entries: 1, netCents: -500 });
    expect([...after.topWinners, ...after.topLosers].some((c) => c.userId === admin)).toBe(false);
  });

  it('activity lists movements newest first, filters and pages', async () => {
    const all = await svc.activity({ account: 'all', q: DOMAIN, limit: 50 });
    expect(all.items.length).toBeGreaterThanOrEqual(8);
    const times = all.items.map((x) => x.createdAt);
    expect([...times].sort().reverse()).toEqual(times);

    const real = await svc.activity({ account: 'real', q: DOMAIN, group: 'trades', limit: 50 });
    expect(real.items.every((x) => x.account === 'real' && ['stake', 'payout', 'refund'].includes(x.kind))).toBe(true);
    const payout = real.items.find((x) => x.kind === 'payout');
    expect(payout?.order).toMatchObject({ asset: 'ZZREP/USD', status: 'won', payoutPct: 85 });

    const p1 = await svc.activity({ account: 'all', q: DOMAIN, limit: 3 });
    expect(p1.items).toHaveLength(3);
    const p2 = await svc.activity({ account: 'all', q: DOMAIN, limit: 50, cursor: p1.nextCursor! });
    expect(p1.items.length + p2.items.length).toBe(all.items.length);
    expect(new Set([...p1.items, ...p2.items].map((x) => x.id)).size).toBe(all.items.length);
  });

  it('rejects an unknown time zone', async () => {
    await expect(svc.results('Not/AZone')).rejects.toThrow('fuso horário inválido');
  });
});
