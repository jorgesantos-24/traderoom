// Requires `npm run dev:deps` and `npm run db:migrate` first.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { Registry } from '@traderoom/shared';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/lib/db.js';
import { SnapshotRetention } from '../src/worker/snapshot-retention.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const SYMBOL = 'ZZRETUSDT';
const DAY = 86_400_000;
let pool: pg.Pool;
let assetId: number;

beforeAll(async () => {
  pool = createPool(loadConfig());
  const { rows } = await pool.query<{ id: number }>(
    `insert into assets (symbol, display, binance_stream, enabled, sort) values ($1, 'ZZRET/USD', 'zzretusdt@bookTicker', false, 9996)
     on conflict (symbol) do update set enabled = false returning id`,
    [SYMBOL],
  );
  assetId = rows[0]?.id ?? 0;
});

afterAll(async () => {
  await pool.query('delete from price_snapshots where asset_id = $1', [assetId]);
  await pool.query('delete from assets where id = $1', [assetId]);
  await pool.end();
});

describe('SnapshotRetention', () => {
  it('deletes rows older than the window in batches and keeps the rest', async () => {
    const now = Date.now();
    await pool.query('delete from price_snapshots where asset_id = $1', [assetId]);
    // 25 rows 8+ days old, 5 inside the window.
    for (let i = 1; i <= 25; i++) {
      await pool.query('insert into price_snapshots (asset_id, price, captured_at) values ($1, 1, $2)', [assetId, new Date(now - 8 * DAY - i * 1000)]);
    }
    for (const age of [60_000, DAY, 3 * DAY, 6 * DAY, 7 * DAY - 60_000]) {
      await pool.query('insert into price_snapshots (asset_id, price, captured_at) values ($1, 2, $2)', [assetId, new Date(now - age)]);
    }
    const lines: unknown[] = [];
    const metrics = new Registry();
    const log = { info: (o: unknown) => void lines.push(o), error: (o: unknown) => void lines.push(o) };
    const r = new SnapshotRetention(
      { pool, metrics, now: () => now, log: log as never },
      { retentionDays: 7, batchSize: 10, everyMs: 1e9, firstRunMs: 1e9 },
    );
    // Other assets may hold old rows too (dev data); this one must lose exactly its 25.
    expect(await r.run()).toBeGreaterThanOrEqual(25);
    const { rows } = await pool.query<{ n: string; old: string }>(
      'select count(*) as n, count(*) filter (where captured_at < $2) as old from price_snapshots where asset_id = $1',
      [assetId, new Date(now - 7 * DAY)],
    );
    expect(Number(rows[0]?.n)).toBe(5);
    expect(Number(rows[0]?.old)).toBe(0);
    expect(metrics.render()).toContain('snapshots_pruned_total');
    expect(await r.run()).toBe(0);
  });
});
