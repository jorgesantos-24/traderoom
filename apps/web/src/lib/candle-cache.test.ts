import { beforeEach, describe, expect, it, vi } from 'vitest';

const candlesMock = vi.fn();
vi.mock('./api', () => ({ api: { candles: (...a: unknown[]) => candlesMock(...a) } }));

const { cachedCandles, clearCandleCache, loadCandles, prefetchCandles, storeCandles, CANDLE_CACHE_MS } = await import('./candle-cache');

const series = (n: number) => Array.from({ length: n }, (_, i) => ({ t: i * 60_000, o: 1, h: 1, l: 1, c: 1, v: 0 }));

beforeEach(() => {
  clearCandleCache();
  candlesMock.mockReset();
  candlesMock.mockImplementation(async (symbol: string, interval: string) => ({ symbol, interval, candles: series(3) }));
});

describe('candle cache', () => {
  it('serves a stored series until it is a minute old', () => {
    storeCandles('BTCUSDT', '1m', series(2), 1000);
    expect(cachedCandles('BTCUSDT', '1m', 1000 + CANDLE_CACHE_MS - 1)).toHaveLength(2);
    expect(cachedCandles('BTCUSDT', '1m', 1000 + CANDLE_CACHE_MS)).toBeNull();
    expect(cachedCandles('BTCUSDT', '5m', 1000)).toBeNull();
  });

  it('shares one request between callers and caches the answer', async () => {
    const [a, b] = await Promise.all([loadCandles('ETHUSDT', '5m', 500), loadCandles('ETHUSDT', '5m', 500)]);
    expect(a).toBe(b);
    expect(candlesMock).toHaveBeenCalledTimes(1);
    expect(cachedCandles('ETHUSDT', '5m')).toHaveLength(3);
  });

  it('still fills the cache when the caller aborts', async () => {
    const ctrl = new AbortController();
    const p = loadCandles('SOLUSDT', '1m', 500, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toBeDefined();
    await vi.waitFor(() => expect(cachedCandles('SOLUSDT', '1m')).not.toBeNull());
  });

  it('prefetch skips what is already cached', async () => {
    storeCandles('BTCUSDT', '1m', series(1));
    prefetchCandles(
      [
        ['BTCUSDT', '1m'],
        ['BTCUSDT', '5m'],
      ],
      500,
    );
    await vi.waitFor(() => expect(cachedCandles('BTCUSDT', '5m')).not.toBeNull());
    expect(candlesMock).toHaveBeenCalledTimes(1);
  });
});
