import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { RedisKeys, type Candle, type CandlesResponse } from '@traderoom/shared';
import { UpstreamError, type KlinesFetcher } from '../src/lib/binance.js';
import { memoryCache } from '../src/lib/cache.js';
import { AppError } from '../src/lib/errors.js';
import { CANDLES_FRESH_MS, CANDLES_KEEP_MS, CANDLES_WARM_AFTER_MS, createCandleService } from '../src/services/candles.js';
import { emptyCandles } from './helpers.js';
import { FAKE_SID, testApp } from './helpers.js';

// Fastify without a logger exposes a no-op logger.
const log = Fastify({ logger: false }).log;
const T0 = 1_800_000_000_000;

function candles(n: number, base = 0): Candle[] {
  return Array.from({ length: n }, (_, i) => ({ t: (base + i) * 60_000, o: i, h: i, l: i, c: i, v: i }));
}

function setup(fetchImpl?: KlinesFetcher) {
  let now = T0;
  const calls: string[] = [];
  const cache = memoryCache(() => now);
  const fetchKlines: KlinesFetcher =
    fetchImpl ??
    (async (symbol, interval, limit) => {
      calls.push(`${symbol}:${interval}:${limit}`);
      return candles(1000, calls.length * 1000);
    });
  const svc = createCandleService({
    cache,
    fetchKlines: async (...a) => {
      if (fetchImpl) calls.push(`${a[0]}:${a[1]}:${a[2]}`);
      return fetchKlines(...a);
    },
    assets: { enabledSymbols: async () => new Set(['BTCUSDT', 'ETHUSDT']) },
    log,
    now: () => now,
  });
  return { svc, calls, cache, advance: (ms: number) => (now += ms), now: () => now };
}

describe('CandleService', () => {
  it('fetches 1000 candles once and serves the last `limit` from cache for 30 s', async () => {
    const s = setup();
    const a = await s.svc.get('BTCUSDT', '1m', 500);
    expect(a).toHaveLength(500);
    expect(a.at(-1)?.t).toBe(1999 * 60_000);
    s.advance(CANDLES_FRESH_MS - 1);
    expect(await s.svc.get('BTCUSDT', '1m', 10)).toHaveLength(10);
    expect(s.calls).toEqual(['BTCUSDT:1m:1000']);
    s.advance(1);
    await s.svc.get('BTCUSDT', '1m', 10);
    expect(s.calls).toEqual(['BTCUSDT:1m:1000', 'BTCUSDT:1m:1000']);
  });

  it('caches per symbol and interval', async () => {
    const s = setup();
    await s.svc.get('BTCUSDT', '1m', 1);
    await s.svc.get('BTCUSDT', '5m', 1);
    await s.svc.get('ETHUSDT', '1m', 1);
    expect(s.calls).toEqual(['BTCUSDT:1m:1000', 'BTCUSDT:5m:1000', 'ETHUSDT:1m:1000']);
    expect([...s.cache.store.keys()].sort()).toEqual([
      RedisKeys.candles('BTCUSDT', '1m'),
      RedisKeys.candles('BTCUSDT', '5m'),
      RedisKeys.candles('ETHUSDT', '1m'),
    ]);
  });

  it('collapses concurrent misses into one upstream call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup(async () => {
      await gate;
      return candles(1000);
    });
    const all = Promise.all(Array.from({ length: 20 }, () => s.svc.get('BTCUSDT', '1m', 5)));
    await new Promise((r) => setTimeout(r, 10));
    release();
    const results = await all;
    expect(results.every((r) => r.length === 5)).toBe(true);
    expect(s.calls).toHaveLength(1);
  });

  it('rejects unknown or disabled symbols without calling Binance', async () => {
    const s = setup();
    const err = await s.svc.get('XRPUSDT', '1m', 5).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ statusCode: 404, code: 'unknown_asset' });
    expect(s.calls).toEqual([]);
  });

  it('on a 429 sets a back-off, serves the stale copy and stops calling Binance until it ends', async () => {
    let fail = false;
    const s = setup(async () => {
      if (fail) throw new UpstreamError('binance 429', 429, 20_000);
      return candles(1000);
    });
    await s.svc.get('BTCUSDT', '1m', 5);
    fail = true;
    s.advance(CANDLES_FRESH_MS);
    expect(await s.svc.get('BTCUSDT', '1m', 5)).toHaveLength(5);
    expect(s.calls).toHaveLength(2);
    expect(await s.cache.get(RedisKeys.binanceRestBackoffUntil)).toBe(String(s.now() + 20_000));

    // During the back-off: no upstream calls at all.
    s.advance(10_000);
    await s.svc.get('BTCUSDT', '1m', 5);
    await s.svc.get('BTCUSDT', '1m', 5);
    expect(s.calls).toHaveLength(2);

    // After it: calls resume.
    fail = false;
    s.advance(10_001);
    await s.svc.get('BTCUSDT', '1m', 5);
    expect(s.calls).toHaveLength(3);
  });

  it('returns 503 when Binance fails and there is no cached copy', async () => {
    const s = setup(async () => {
      throw new UpstreamError('binance 500', 500);
    });
    await expect(s.svc.get('BTCUSDT', '1m', 5)).rejects.toMatchObject({ statusCode: 503, code: 'service_unavailable' });
  });

  it('returns 503 during a back-off when nothing is cached', async () => {
    const s = setup();
    await s.cache.set(RedisKeys.binanceRestBackoffUntil, String(s.now() + 5000), 5000);
    await expect(s.svc.get('BTCUSDT', '1m', 5)).rejects.toMatchObject({ statusCode: 503 });
    expect(s.calls).toEqual([]);
  });

  it('drops stale copies after the keep window', async () => {
    let fail = false;
    const s = setup(async () => {
      if (fail) throw new UpstreamError('binance 500', 500);
      return candles(1000);
    });
    await s.svc.get('BTCUSDT', '1m', 5);
    fail = true;
    s.advance(CANDLES_KEEP_MS);
    await expect(s.svc.get('BTCUSDT', '1m', 5)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('still works when the cache itself fails', async () => {
    const svc = createCandleService({
      cache: {
        get: async () => Promise.reject(new Error('redis down')),
        set: async () => Promise.reject(new Error('redis down')),
      },
      fetchKlines: async () => candles(1000),
      assets: { enabledSymbols: async () => new Set(['BTCUSDT']) },
      log,
    });
    expect(await svc.get('BTCUSDT', '1m', 3)).toHaveLength(3);
  });
});

describe('candle warmer', () => {
  it('fetches every enabled symbol × interval once, then skips copies that are still recent', async () => {
    const { svc, calls, advance } = setup();
    await svc.warmOnce(['1m', '5m']);
    expect(calls.sort()).toEqual(['BTCUSDT:1m:1000', 'BTCUSDT:5m:1000', 'ETHUSDT:1m:1000', 'ETHUSDT:5m:1000']);
    advance(CANDLES_WARM_AFTER_MS - 1);
    await svc.warmOnce(['1m', '5m']);
    expect(calls).toHaveLength(4);
    advance(1);
    await svc.warmOnce(['1m', '5m']);
    expect(calls).toHaveLength(8);
  });

  it('lets reads hit the cache after a warm pass', async () => {
    const { svc, calls } = setup();
    await svc.warmOnce(['1m']);
    await svc.get('BTCUSDT', '1m', 500);
    await svc.get('ETHUSDT', '1m', 500);
    expect(calls).toHaveLength(2);
  });

  it('keeps going when one upstream call fails', async () => {
    let n = 0;
    const { svc } = setup(async () => {
      n += 1;
      if (n === 1) throw new UpstreamError('boom', 500);
      return candles(10);
    });
    await expect(svc.warmOnce(['1m'])).resolves.toBeUndefined();
    expect(n).toBe(2);
  });

  it('startWarming runs a pass right away and stops cleanly', async () => {
    const { svc, calls } = setup();
    const stop = svc.startWarming(['1m']);
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(calls).toHaveLength(2);
  });
});

describe('GET /api/candles', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const seen: unknown[][] = [];
  const fakeCandles = {
    ...emptyCandles,
    get: async (...args: unknown[]) => {
      seen.push(args);
      return candles(3);
    },
  };

  async function get(url: string, cookie = `sid=${FAKE_SID}`) {
    app ??= await testApp({ candles: fakeCandles });
    return app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  }

  it('requires a session', async () => {
    const res = await get('/api/candles?symbol=BTCUSDT', '');
    expect(res.statusCode).toBe(401);
  });

  it('returns candles with defaults interval=1m, limit=500', async () => {
    seen.length = 0;
    const res = await get('/api/candles?symbol=btcusdt');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, max-age=5');
    const body = res.json<CandlesResponse>();
    expect(body.symbol).toBe('BTCUSDT');
    expect(body.interval).toBe('1m');
    expect(body.candles).toHaveLength(3);
    expect(seen).toEqual([['BTCUSDT', '1m', 500]]);
  });

  it.each([
    ['/api/candles', 'symbol'],
    ['/api/candles?symbol=BTC/USDT', 'symbol'],
    ['/api/candles?symbol=BTCUSDT&interval=2m', 'interval'],
    ['/api/candles?symbol=BTCUSDT&limit=0', 'limit'],
    ['/api/candles?symbol=BTCUSDT&limit=1001', 'limit'],
    ['/api/candles?symbol=BTCUSDT&limit=abc', 'limit'],
    ['/api/candles?symbol=BTCUSDT&limit=1.5', 'limit'],
  ])('rejects %s with 400', async (url, field) => {
    const res = await get(url);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'validation_failed' } });
    expect(res.json<{ error: { message: string } }>().error.message).toContain(field);
  });

  it('passes service errors through in the standard format', async () => {
    app = await testApp({
      candles: {
        ...emptyCandles,
        get: async () => {
          throw new AppError(404, 'unknown_asset', 'Ativo não encontrado.');
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/candles?symbol=XRPUSDT', headers: { cookie: `sid=${FAKE_SID}` } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'unknown_asset', message: 'Ativo não encontrado.' } });
  });
});
