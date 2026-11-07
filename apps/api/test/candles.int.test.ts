// Requires `npm run dev:deps` and `npm run db:migrate` first.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { RedisKeys, type Candle } from '@traderoom/shared';
import { loadConfig } from '../src/config.js';
import { UpstreamError } from '../src/lib/binance.js';
import { redisCache } from '../src/lib/cache.js';
import { createPool } from '../src/lib/db.js';
import { createRedis } from '../src/lib/redis.js';
import { createAssetRepo } from '../src/services/assets.js';
import { CANDLES_KEEP_MS, createCandleService } from '../src/services/candles.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const log = Fastify({ logger: false }).log;
let pool: pg.Pool;
let redis: Redis;

const KEYS = [RedisKeys.candles('ETHUSDT', '4h'), RedisKeys.binanceRestBackoffUntil];

beforeAll(async () => {
  pool = createPool(config);
  redis = createRedis(config);
  await redis.del(...KEYS);
});

afterAll(async () => {
  await redis.del(...KEYS);
  await Promise.all([pool.end(), redis.quit()]);
});

const sample: Candle[] = Array.from({ length: 1000 }, (_, i) => ({ t: i * 14_400_000, o: 1, h: 2, l: 0.5, c: 1.5, v: i }));

describe('candles with real Redis and Postgres', () => {
  it('caches in Redis, validates against enabled assets and records a 429 back-off', async () => {
    let calls = 0;
    let fail = false;
    const svc = createCandleService({
      cache: redisCache(redis),
      assets: createAssetRepo(pool),
      log,
      fetchKlines: async () => {
        calls += 1;
        if (fail) throw new UpstreamError('binance 429', 429, 2000);
        return sample;
      },
    });

    expect(await svc.get('ETHUSDT', '4h', 2)).toEqual(sample.slice(-2));
    const ttl = await redis.pttl(RedisKeys.candles('ETHUSDT', '4h'));
    expect(ttl).toBeGreaterThan(CANDLES_KEEP_MS - 5000);
    const stored = JSON.parse((await redis.get(RedisKeys.candles('ETHUSDT', '4h'))) ?? '{}') as { candles: Candle[] };
    expect(stored.candles).toHaveLength(1000);

    // Second service instance (e.g. after a restart) reuses the Redis copy.
    const svc2 = createCandleService({
      cache: redisCache(redis),
      assets: createAssetRepo(pool),
      log,
      fetchKlines: async () => {
        throw new Error('must not be called');
      },
    });
    expect(await svc2.get('ETHUSDT', '4h', 1000)).toHaveLength(1000);

    await expect(svc.get('NOPEUSDT', '4h', 2)).rejects.toMatchObject({ statusCode: 404 });
    expect(calls).toBe(1);

    // Force a refresh that hits a 429.
    await redis.del(RedisKeys.candles('ETHUSDT', '4h'));
    fail = true;
    await expect(svc.get('ETHUSDT', '4h', 2)).rejects.toMatchObject({ statusCode: 503 });
    const until = Number(await redis.get(RedisKeys.binanceRestBackoffUntil));
    expect(until).toBeGreaterThan(Date.now());
    expect(await redis.pttl(RedisKeys.binanceRestBackoffUntil)).toBeLessThanOrEqual(2000);
    await expect(svc.get('ETHUSDT', '4h', 2)).rejects.toMatchObject({ statusCode: 503 });
    expect(calls).toBe(2);
  });
});
