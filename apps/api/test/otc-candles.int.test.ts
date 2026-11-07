// Requires `npm run dev:deps` and `npm run db:migrate` first.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/lib/db.js';
import { createAssetRepo } from '../src/services/assets.js';
import { createOtcCandleSource } from '../src/services/otc-candles.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const SYMBOL = 'ZZTESTOTC';
let pool: pg.Pool;
let assetId: number;
// A fixed minute boundary, so buckets are known.
const T0 = Date.UTC(2026, 10, 7, 12, 0, 0);

beforeAll(async () => {
  pool = createPool(loadConfig());
  await pool.query(`delete from price_snapshots where asset_id in (select id from assets where symbol = $1)`, [SYMBOL]);
  await pool.query(`delete from assets where symbol = $1`, [SYMBOL]);
  const { rows } = await pool.query<{ id: number }>(
    `insert into assets (symbol, display, kind, enabled, otc_start_price, otc_vol_pct_hour, otc_decimals)
     values ($1, 'Teste (OTC)', 'otc', true, 1, 1, 2) returning id`,
    [SYMBOL],
  );
  assetId = rows[0]!.id;
  const points: Array<[number, number]> = [
    [0, 1],
    [10, 3],
    [20, 0.5],
    [59, 2],
    [60, 5],
    [90, 4],
  ];
  for (const [s, p] of points) {
    await pool.query('insert into price_snapshots (asset_id, price, captured_at) values ($1, $2, $3)', [
      assetId,
      p,
      new Date(T0 + s * 1000),
    ]);
  }
});

afterAll(async () => {
  await pool.query('delete from price_snapshots where asset_id = $1', [assetId]);
  await pool.query('delete from assets where id = $1', [assetId]);
  await pool.end();
});

describe('OTC candles', () => {
  it('builds UTC-aligned OHLC candles from stored prices', async () => {
    const src = createOtcCandleSource(pool, createAssetRepo(pool, { ttlMs: 0 }), { now: () => T0 + 100_000 });
    expect(await src.has(SYMBOL)).toBe(true);
    expect(await src.has('BTCUSDT')).toBe(false);
    expect(await src.candles(SYMBOL, '1m', 5)).toEqual([
      { t: T0, o: 1, h: 3, l: 0.5, c: 2, v: 0 },
      { t: T0 + 60_000, o: 5, h: 5, l: 4, c: 4, v: 0 },
    ]);
    // Only the newest bucket when the limit is 1.
    const one = await createOtcCandleSource(pool, createAssetRepo(pool, { ttlMs: 0 }), { now: () => T0 + 100_000 }).candles(
      SYMBOL,
      '1m',
      1,
    );
    expect(one).toEqual([{ t: T0 + 60_000, o: 5, h: 5, l: 4, c: 4, v: 0 }]);
  });
});
