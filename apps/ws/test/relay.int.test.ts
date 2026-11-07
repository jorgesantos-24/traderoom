// Requires `npm run dev:deps` and `npm run db:migrate` first.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { isPriceStale, parsePriceRecord, PRICE_TTL_MS, RedisKeys } from '@traderoom/shared';
import { loadConfig } from '../src/config.js';
import { RELAY_DEFAULTS, Relay } from '../src/feed/relay.js';
import { insertSnapshots, loadEnabledAssets, writePricesToRedis } from '../src/feed/sinks.js';
import type { FeedAsset } from '../src/feed/types.js';
import { createPool } from '../src/lib/db.js';
import { Registry } from '../src/lib/metrics.js';
import { createRedis } from '../src/lib/redis.js';
import { binanceQuote, FakeUpstream, pump, silentLog } from './fake-upstream.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const SYMBOL = 'ZZTESTUSDT';
let pool: pg.Pool;
let redis: Redis;
let asset: FeedAsset;

beforeAll(async () => {
  pool = createPool(config.DATABASE_URL, 2);
  redis = createRedis(config.REDIS_URL);
  // A throwaway asset keeps test rows out of real price history.
  const { rows } = await pool.query<{ id: number }>(
    `insert into assets (symbol, display, binance_stream, enabled, sort)
     values ($1, 'ZZTEST/USD', $2, false, 9999)
     on conflict (symbol) do update set enabled = false
     returning id`,
    [SYMBOL, `${SYMBOL.toLowerCase()}@bookTicker`],
  );
  asset = { id: rows[0]?.id ?? 0, symbol: SYMBOL, binanceStream: `${SYMBOL.toLowerCase()}@bookTicker` };
  await pool.query('delete from price_snapshots where asset_id = $1', [asset.id]);
});

afterAll(async () => {
  await pool.query('delete from price_snapshots where asset_id = $1', [asset.id]);
  await pool.query('delete from assets where id = $1', [asset.id]);
  await redis.del(RedisKeys.price(SYMBOL), RedisKeys.feedLastTickMs);
  await Promise.all([pool.end(), redis.quit()]);
});

describe('loadEnabledAssets', () => {
  it('loads the seeded assets in sort order and validates streams', async () => {
    const { assets, invalid } = await loadEnabledAssets(pool);
    expect(assets.map((a) => a.symbol).slice(0, 3)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(assets.find((a) => a.symbol === SYMBOL)).toBeUndefined(); // disabled
    expect(invalid).toEqual([]);
  });

  it('skips a stream that belongs to another symbol', async () => {
    await pool.query('update assets set enabled = true, binance_stream = $2 where id = $1', [asset.id, 'btcusdt@bookTicker']);
    try {
      const { assets, invalid } = await loadEnabledAssets(pool);
      expect(assets.find((a) => a.symbol === SYMBOL)).toBeUndefined();
      expect(invalid.map((a) => a.symbol)).toEqual([SYMBOL]);
    } finally {
      await pool.query('update assets set enabled = false, binance_stream = $2 where id = $1', [asset.id, asset.binanceStream]);
    }
  });
});

describe('relay against real Redis and Postgres', () => {
  it('writes px:<symbol> with a 5 s TTL, the last tick time and 1 s snapshots; goes stale after 2 s', async () => {
    const binance = await FakeUpstream.start();
    const backup = await FakeUpstream.start();
    const relay = new Relay(
      {
        ...RELAY_DEFAULTS, // real 200 ms window, 2 s stale, 1 s snapshots
        binanceUrl: binance.url,
        binanceBackupUrl: backup.url,
        assetsReloadMs: 60_000,
      },
      {
        log: silentLog,
        metrics: new Registry(),
        sinks: {
          writePrices: (t) => writePricesToRedis(redis, t),
          writeSnapshots: (r) => insertSnapshots(pool, r),
          loadAssets: async () => [asset],
        },
      },
    );
    const startedAt = new Date();
    await relay.start();
    try {
      await vi.waitFor(() => expect(binance.open).toBe(1));
      const stopPump = pump(binance, 50, () => binanceQuote(SYMBOL, '12345.67890122', '12345.67890124'));

      await vi.waitFor(async () => {
        const rec = parsePriceRecord(await redis.get(RedisKeys.price(SYMBOL)));
        expect(rec).toMatchObject({ p: '12345.67890123', src: 'binance' });
      });
      const ttl = await redis.pttl(RedisKeys.price(SYMBOL));
      expect(ttl).toBeGreaterThan(PRICE_TTL_MS - 1000);
      expect(ttl).toBeLessThanOrEqual(PRICE_TTL_MS);
      const last = Number(await redis.get(RedisKeys.feedLastTickMs));
      expect(Date.now() - last).toBeLessThan(1000);

      await vi.waitFor(
        async () => {
          const { rows } = await pool.query<{ n: string }>('select count(*) as n from price_snapshots where asset_id = $1', [asset.id]);
          expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(2);
        },
        { timeout: 4000 },
      );
      const { rows } = await pool.query<{ price: string; captured_at: Date }>(
        'select price::text, captured_at from price_snapshots where asset_id = $1 order by captured_at',
        [asset.id],
      );
      expect(rows.every((r) => r.price === '12345.67890123')).toBe(true);
      expect(rows.every((r) => r.captured_at >= new Date(startedAt.getTime() - 1000))).toBe(true);
      // About one per second.
      const gaps = rows.slice(1).map((r, i) => r.captured_at.getTime() - (rows[i]?.captured_at.getTime() ?? 0));
      for (const g of gaps) expect(g).toBeGreaterThan(800);

      // Kill the feed: stale within ~2 s, and the API-side check agrees.
      stopPump();
      binance.dropAll();
      binance.accepting = false;
      const killedAt = Date.now();
      await vi.waitFor(() => expect(relay.isStale(SYMBOL)).toBe(true), { timeout: 3000, interval: 20 });
      const detectMs = Date.now() - killedAt;
      expect(detectMs).toBeLessThan(2300);
      const rec = parsePriceRecord(await redis.get(RedisKeys.price(SYMBOL)));
      expect(isPriceStale(rec, Date.now())).toBe(true);

      // No snapshots while stale.
      const before = await pool.query('select count(*) from price_snapshots where asset_id = $1', [asset.id]);
      await new Promise((r) => setTimeout(r, 1300));
      const after = await pool.query('select count(*) from price_snapshots where asset_id = $1', [asset.id]);
      expect(after.rows).toEqual(before.rows);

      // Recovery: the relay reconnects on its own and the symbol is fresh again.
      binance.accepting = true;
      await vi.waitFor(() => expect(binance.open).toBe(1), { timeout: 5000 });
      // The outage may outlast failoverMs, moving the symbol to the backup endpoint: quote on both,
      // as both Binance endpoints carry the same market.
      const stopRecovery = pump(binance, 50, () => binanceQuote(SYMBOL, '12346.00000000'));
      const stopBackup = pump(backup, 50, () => binanceQuote(SYMBOL, '12346.00000000'));
      await vi.waitFor(() => expect(relay.isStale(SYMBOL)).toBe(false), { timeout: 3000 });
      await vi.waitFor(async () => {
        const fresh = parsePriceRecord(await redis.get(RedisKeys.price(SYMBOL)));
        expect(fresh?.p).toBe('12346.00000000');
        expect(isPriceStale(fresh, Date.now())).toBe(false);
      });
      stopRecovery();
      stopBackup();
    } finally {
      await relay.stop();
      await Promise.all([binance.stop(), backup.stop()]);
    }
  }, 20_000);
});
