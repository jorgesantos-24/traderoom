import { beforeEach, describe, expect, it, vi } from 'vitest';

const candlesMock = vi.fn();
vi.mock('./api', () => ({ api: { candles: (...a: unknown[]) => candlesMock(...a) } }));

const { cachedCandles, clearCandleCache, loadCandles, loadOlderCandles, prefetchCandles, storeCandles, CANDLE_CACHE_MS } =
  await import('./candle-cache');

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

  it('a short series (15 daily candles for a level) never stands in for a chart', async () => {
    candlesMock.mockImplementation(async (_s: string, _i: string, limit: number) => ({ candles: series(Math.min(limit, 20)) }));
    const [short, full] = await Promise.all([loadCandles('BTCUSDT', '1d', 15), loadCandles('BTCUSDT', '1d', 500)]);
    expect(short).toHaveLength(15);
    expect(full).toHaveLength(20);
    expect(candlesMock).toHaveBeenCalledTimes(2);
    await loadCandles('BTCUSDT', '1d', 15);
    expect(cachedCandles('BTCUSDT', '1d', Date.now(), 500)).toHaveLength(20);
    storeCandles('ETHUSDT', '1d', series(15), Date.now(), 15);
    expect(cachedCandles('ETHUSDT', '1d', Date.now(), 500)).toBeNull();
  });

  it('older history asks with `before` and keeps only earlier candles', async () => {
    candlesMock.mockImplementation(async () => ({ candles: series(5) }));
    const older = await loadOlderCandles('BTCUSDT', '1m', 3 * 60_000, 1000);
    expect(older.map((c) => c.t)).toEqual([0, 60_000, 120_000]);
    expect(candlesMock).toHaveBeenCalledWith('BTCUSDT', '1m', 1000, undefined, 3 * 60_000);
  });
});
