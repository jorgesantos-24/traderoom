import type { Candle, CandleInterval } from '@traderoom/shared';
import { api } from './api';

/** A cached series is shown instantly for this long; the chart still refreshes it in the background. */
export const CANDLE_CACHE_MS = 60_000;
const MAX_ENTRIES = 40;

interface Entry {
  at: number;
  candles: Candle[];
  /** How many were asked for: a short series (e.g. 15 daily candles for a level) must not stand in for a chart's. */
  limit: number;
}

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<Candle[]>>();
const key = (symbol: string, interval: CandleInterval) => `${symbol}:${interval}`;

/** Recent history for a chart (loaded for at least `limit` candles), or null when there is none worth showing. */
export function cachedCandles(symbol: string, interval: CandleInterval, now = Date.now(), limit = 0): Candle[] | null {
  const e = cache.get(key(symbol, interval));
  return e && now - e.at < CANDLE_CACHE_MS && e.limit >= limit ? e.candles : null;
}

export function storeCandles(symbol: string, interval: CandleInterval, candles: Candle[], now = Date.now(), limit = Infinity): void {
  const k = key(symbol, interval);
  const old = cache.get(k);
  // A fresh longer series stays; a shorter request only fills in what is missing.
  if (old && old.limit > limit && now - old.at < CANDLE_CACHE_MS) return;
  cache.delete(k);
  cache.set(k, { at: now, candles, limit });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
}

/** Fetches and caches a series, sharing one request between callers. */
export function loadCandles(symbol: string, interval: CandleInterval, limit: number, signal?: AbortSignal): Promise<Candle[]> {
  // Shared only between callers asking for the same length.
  const k = `${key(symbol, interval)}:${limit}`;
  let p = inFlight.get(k);
  if (!p) {
    p = api
      .candles(symbol, interval, limit)
      .then((r) => {
        storeCandles(symbol, interval, r.candles, Date.now(), limit);
        return r.candles;
      })
      .finally(() => inFlight.delete(k));
    inFlight.set(k, p);
  }
  return abortable(p, signal);
}

/** Older history (the chart scrolled back): the `limit` candles opening before `before`, [] past the start. */
export function loadOlderCandles(
  symbol: string,
  interval: CandleInterval,
  before: number,
  limit: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  return api.candles(symbol, interval, limit, signal, before).then((r) => r.candles.filter((c) => c.t < before));
}

function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  // Abort only stops this caller from waiting; the shared request still fills the cache.
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Warms the cache for charts the user is likely to open next. Errors are ignored. */
export function prefetchCandles(pairs: ReadonlyArray<readonly [string, CandleInterval]>, limit: number): void {
  for (const [symbol, interval] of pairs) {
    if (cachedCandles(symbol, interval, Date.now(), limit) || inFlight.has(`${key(symbol, interval)}:${limit}`)) continue;
    loadCandles(symbol, interval, limit).catch(() => {});
  }
}

/** Test hook. */
export function clearCandleCache(): void {
  cache.clear();
  inFlight.clear();
}
