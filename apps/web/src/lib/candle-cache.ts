import type { Candle, CandleInterval } from '@traderoom/shared';
import { api } from './api';

/** A cached series is shown instantly for this long; the chart still refreshes it in the background. */
export const CANDLE_CACHE_MS = 60_000;
const MAX_ENTRIES = 40;

interface Entry {
  at: number;
  candles: Candle[];
}

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<Candle[]>>();
const key = (symbol: string, interval: CandleInterval) => `${symbol}:${interval}`;

/** Recent history for a chart, or null when there is none worth showing. */
export function cachedCandles(symbol: string, interval: CandleInterval, now = Date.now()): Candle[] | null {
  const e = cache.get(key(symbol, interval));
  return e && now - e.at < CANDLE_CACHE_MS ? e.candles : null;
}

export function storeCandles(symbol: string, interval: CandleInterval, candles: Candle[], now = Date.now()): void {
  const k = key(symbol, interval);
  cache.delete(k);
  cache.set(k, { at: now, candles });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
}

/** Fetches and caches a series, sharing one request between callers. */
export function loadCandles(symbol: string, interval: CandleInterval, limit: number, signal?: AbortSignal): Promise<Candle[]> {
  const k = key(symbol, interval);
  let p = inFlight.get(k);
  if (!p) {
    p = api
      .candles(symbol, interval, limit)
      .then((r) => {
        storeCandles(symbol, interval, r.candles);
        return r.candles;
      })
      .finally(() => inFlight.delete(k));
    inFlight.set(k, p);
  }
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
    if (cachedCandles(symbol, interval) || inFlight.has(key(symbol, interval))) continue;
    loadCandles(symbol, interval, limit).catch(() => {});
  }
}

/** Test hook. */
export function clearCandleCache(): void {
  cache.clear();
  inFlight.clear();
}
