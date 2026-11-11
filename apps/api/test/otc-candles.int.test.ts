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
const MARKET = 'ZZTESTMKT';
let pool: pg.Pool;
let assetId: number;
let marketId: number;
// A fixed minute boundary, so buckets are known.
const T0 = Date.UTC(2026, 10, 7, 12, 0, 0);

beforeAll(async () => {
  pool = createPool(loadConfig());
  await pool.query(`delete from price_snapshots where asset_id in (select id from assets where symbol = $1)`, [SYMBOL]);
  await pool.query(`delete from price_snapshots where asset_id in (select id from assets where symbol = $1)`, [MARKET]);
  await pool.query(`delete from assets where symbol = any($1)`, [[SYMBOL, MARKET]]);
  marketId = (
    await pool.query<{ id: number }>(
      `insert into assets (symbol, display, binance_stream, payout_pct, enabled, sort)
       values ($1, 'ZZMKT/USD', 'zztestmktusdt@bookTicker', 80, true, 9996) returning id`,
      [MARKET],
    )
  ).rows[0]!.id;
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
    await pool.query('insert into price_snapshots (asset_id, price, captured_at) values ($1, $2, $3)', [
      marketId,
      p * 10,
      new Date(T0 + s * 1000),
    ]);
  }
});

// Minutes older than the snapshot window, as retention rolls them up (11:00 and 11:01).
const H = 3_600_000;
beforeAll(async () => {
  await pool.query(
    `insert into price_candles_1m (asset_id, t, o, h, l, c) values ($1, $2, 1, 2, 0.5, 1.5), ($1, $3, 1.4, 1.8, 1.2, 1.6)`,
    [assetId, new Date(T0 - H), new Date(T0 - H + 60_000)],
  );
});

afterAll(async () => {
  await pool.query('delete from price_snapshots where asset_id = any($1)', [[assetId, marketId]]);
  await pool.query('delete from assets where id = any($1)', [[assetId, marketId]]);
  await pool.end();
});

describe('OTC candles', () => {
  it('builds UTC-aligned OHLC candles; each opens at the previous close', async () => {
    const src = createOtcCandleSource(pool, createAssetRepo(pool, { ttlMs: 0 }), { now: () => T0 + 100_000 });
    expect(await src.has(SYMBOL)).toBe(true);
    expect(await src.has('BTCUSDT')).toBe(false);
    expect(await src.candles(SYMBOL, '1m', 5)).toEqual([
      { t: T0, o: 1, h: 3, l: 0.5, c: 2, v: 0 },
      // Opens at the previous close (2), not at its own first price (5); the low reaches the open.
      { t: T0 + 60_000, o: 2, h: 5, l: 2, c: 4, v: 0 },
    ]);
    // Only the newest bucket when the limit is 1, still opening at the close before it.
    const one = await createOtcCandleSource(pool, createAssetRepo(pool, { ttlMs: 0 }), { now: () => T0 + 100_000 }).candles(
      SYMBOL,
      '1m',
      1,
    );
    expect(one).toEqual([{ t: T0 + 60_000, o: 2, h: 5, l: 2, c: 4, v: 0 }]);
  });

  it('after a missing bucket (feed down) the candle opens at its own first price', async () => {
    await pool.query('insert into price_snapshots (asset_id, price, captured_at) values ($1, 7, $2), ($1, 8, $3)', [
      assetId,
      new Date(T0 + 300_000),
      new Date(T0 + 330_000),
    ]);
    const src = createOtcCandleSource(pool, createAssetRepo(pool, { ttlMs: 0 }), { now: () => T0 + 340_000 });
    expect((await src.candles(SYMBOL, '1m', 6)).at(-1)).toEqual({ t: T0 + 300_000, o: 7, h: 8, l: 7, c: 8, v: 0 });
  });

  it('fromSnapshots builds the same candles for a market asset; candles() stays OTC-only', async () => {
    const src = createOtcCandleSource(pool, createAssetRepo(pool, { ttlMs: 0 }), { now: () => T0 + 100_000 });
    expect(await src.has(MARKET)).toBe(false);
    expect(await src.candles(MARKET, '1m', 5)).toEqual([]);
    expect(await src.fromSnapshots(MARKET, '1m', 5)).toEqual([
      { t: T0, o: 10, h: 30, l: 5, c: 20, v: 0 },
      { t: T0 + 60_000, o: 20, h: 50, l: 20, c: 40, v: 0 },
    ]);
    expect(await src.fromSnapshots('ZZNOPE', '1m', 5)).toEqual([]);
  });

  it('pages back with `before`, reading rolled-up minutes once the snapshots are gone', async () => {
    const src = createOtcCandleSource(pool, createAssetRepo(pool, { ttlMs: 0 }), { now: () => T0 + 100_000 });
    expect(await src.candles(SYMBOL, '1m', 2, T0 - H + 120_000)).toEqual([
      { t: T0 - H, o: 1, h: 2, l: 0.5, c: 1.5, v: 0 },
      // Opens at the previous close, as snapshot candles do.
      { t: T0 - H + 60_000, o: 1.5, h: 1.8, l: 1.2, c: 1.6, v: 0 },
    ]);
    // Longer buckets combine the minutes: first open, highest high, lowest low, last close.
    expect(await src.candles(SYMBOL, '1h', 1, T0)).toEqual([{ t: T0 - H, o: 1, h: 2, l: 0.5, c: 1.6, v: 0 }]);
    // `before` is exclusive, and there is nothing before 11:00.
    expect(await src.candles(SYMBOL, '1m', 5, T0 - H)).toEqual([]);
  });
});
