import type { FastifyBaseLogger } from 'fastify';
import { CANDLES_UPSTREAM_LIMIT, ErrorCode, RedisKeys, type Candle, type CandleInterval } from '@traderoom/shared';
import { UpstreamError, type KlinesFetcher } from '../lib/binance.js';
import type { KvCache } from '../lib/cache.js';
import { AppError } from '../lib/errors.js';
import type { AssetRepo } from './assets.js';
import type { OtcCandleSource } from './otc-candles.js';

/** Served from cache without calling Binance for this long (spec: 30 s). */
export const CANDLES_FRESH_MS = 30_000;
/** Older copies are kept this long and served only while Binance is failing or backing us off. */
export const CANDLES_KEEP_MS = 10 * 60_000;

interface CachedCandles {
  fetchedAt: number;
  candles: Candle[];
}

/** The warmer refreshes a cached series once it is older than this, so reads stay under CANDLES_FRESH_MS. */
export const CANDLES_WARM_AFTER_MS = 15_000;
/** Pause between warmer passes. */
export const CANDLES_WARM_PAUSE_MS = 5_000;

/**
 * Market intervals served from price_snapshots (the platform's price, overrides included) instead of
 * Binance. Longer ones stay on Binance: snapshots are kept 7 days, too short for 30m+ series.
 */
export const SNAPSHOT_INTERVALS: ReadonlySet<CandleInterval> = new Set<CandleInterval>(['1m', '5m', '15m']);

export interface CandleService {
  get(symbol: string, interval: CandleInterval, limit: number): Promise<Candle[]>;
  /** One pass of the warmer: refreshes every enabled symbol × interval whose copy is getting old. */
  warmOnce(intervals: readonly CandleInterval[]): Promise<void>;
  /**
   * Keeps the cache warm in the background so chart switches read Redis instead of
   * waiting on Binance (a cold connection from here costs seconds). Returns a stop function.
   */
  startWarming(intervals: readonly CandleInterval[]): () => void;
}

export interface CandleServiceDeps {
  cache: KvCache;
  fetchKlines: KlinesFetcher;
  assets: Pick<AssetRepo, 'enabledSymbols'>;
  /** Snapshot candles: every interval of OTC assets, and SNAPSHOT_INTERVALS of market ones. */
  otc?: OtcCandleSource;
  log: FastifyBaseLogger;
  now?: () => number;
}

function parseCached(raw: string | null): CachedCandles | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as CachedCandles;
    return typeof v.fetchedAt === 'number' && Array.isArray(v.candles) ? v : null;
  } catch {
    return null;
  }
}

const unavailable = (): AppError =>
  new AppError(503, ErrorCode.Unavailable, 'Histórico de preços indisponível no momento. Tente novamente em instantes.');

export function createCandleService(deps: CandleServiceDeps): CandleService {
  const now = deps.now ?? Date.now;
  // One upstream call per (symbol, interval) at a time, however many requests are waiting.
  const inFlight = new Map<string, Promise<Candle[]>>();

  async function safeGet(key: string): Promise<string | null> {
    try {
      return await deps.cache.get(key);
    } catch (err) {
      deps.log.warn({ err, key }, 'candle cache read failed');
      return null;
    }
  }

  async function safeSet(key: string, value: string, ttlMs: number): Promise<void> {
    try {
      await deps.cache.set(key, value, ttlMs);
    } catch (err) {
      deps.log.warn({ err, key }, 'candle cache write failed');
    }
  }

  async function refresh(symbol: string, interval: CandleInterval, key: string, cached: CachedCandles | null): Promise<Candle[]> {
    const backoffUntil = Number(await safeGet(RedisKeys.binanceRestBackoffUntil));
    if (Number.isFinite(backoffUntil) && now() < backoffUntil) {
      if (cached) return cached.candles;
      throw unavailable();
    }
    try {
      const candles = await deps.fetchKlines(symbol, interval, CANDLES_UPSTREAM_LIMIT);
      const entry: CachedCandles = { fetchedAt: now(), candles };
      await safeSet(key, JSON.stringify(entry), CANDLES_KEEP_MS);
      return candles;
    } catch (err) {
      if (err instanceof UpstreamError && err.retryAfterMs !== undefined) {
        deps.log.error({ status: err.status, retryAfterMs: err.retryAfterMs }, 'binance asked us to back off; pausing klines calls');
        await safeSet(RedisKeys.binanceRestBackoffUntil, String(now() + err.retryAfterMs), err.retryAfterMs);
      } else {
        deps.log.error({ err, symbol, interval }, 'klines fetch failed');
      }
      if (cached) return cached.candles;
      throw unavailable();
    }
  }

  function refreshOnce(symbol: string, interval: CandleInterval, key: string, cached: CachedCandles | null): Promise<Candle[]> {
    let p = inFlight.get(key);
    if (!p) {
      p = refresh(symbol, interval, key, cached).finally(() => inFlight.delete(key));
      inFlight.set(key, p);
    }
    return p;
  }

  async function warmOnce(intervals: readonly CandleInterval[]): Promise<void> {
    const symbols = [...(await deps.assets.enabledSymbols())];
    // One at a time: gentle on Binance and it keeps a single connection alive.
    for (const symbol of symbols) {
      if (await deps.otc?.has(symbol)) continue;
      for (const interval of intervals) {
        // These come from snapshots, not Binance.
        if (deps.otc && SNAPSHOT_INTERVALS.has(interval)) continue;
        const key = RedisKeys.candles(symbol, interval);
        const cached = parseCached(await safeGet(key));
        if (cached && now() - cached.fetchedAt < CANDLES_WARM_AFTER_MS) continue;
        try {
          await refreshOnce(symbol, interval, key, cached);
        } catch {
          // refresh() already logged it; the next pass retries.
        }
      }
    }
  }

  return {
    warmOnce,
    startWarming(intervals) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const loop = async () => {
        if (stopped) return;
        try {
          await warmOnce(intervals);
        } catch (err) {
          deps.log.warn({ err }, 'candle warmer pass failed');
        }
        if (!stopped) timer = setTimeout(() => void loop(), CANDLES_WARM_PAUSE_MS);
      };
      void loop();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    },
    async get(symbol, interval, limit) {
      const enabled = await deps.assets.enabledSymbols();
      if (!enabled.has(symbol)) throw new AppError(404, ErrorCode.UnknownAsset, 'Ativo não encontrado.');
      if (deps.otc && (await deps.otc.has(symbol))) return (await deps.otc.candles(symbol, interval, limit)).slice(-limit);
      // The chart shows the platform's price: the same one orders settle at.
      if (deps.otc && SNAPSHOT_INTERVALS.has(interval)) return (await deps.otc.fromSnapshots(symbol, interval, limit)).slice(-limit);

      const key = RedisKeys.candles(symbol, interval);
      const cached = parseCached(await safeGet(key));
      let candles: Candle[];
      if (cached && now() - cached.fetchedAt < CANDLES_FRESH_MS) {
        candles = cached.candles;
      } else {
        candles = await refreshOnce(symbol, interval, key, cached);
      }
      return candles.slice(-limit);
    },
  };
}
