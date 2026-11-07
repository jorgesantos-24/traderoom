import { describe, expect, it } from 'vitest';
import type { Candle } from '@traderoom/shared';
import { bucketStart, intervalMs, mergePrice } from './candles';

const M = 60_000;

describe('intervalMs', () => {
  it('converts every interval', () => {
    expect(intervalMs('1m')).toBe(M);
    expect(intervalMs('15m')).toBe(15 * M);
    expect(intervalMs('4h')).toBe(4 * 60 * M);
    expect(intervalMs('1d')).toBe(24 * 60 * M);
    expect(bucketStart(5 * M + 59_999, M)).toBe(5 * M);
  });
});

describe('mergePrice', () => {
  const base = (): Candle[] => [{ t: 10 * M, o: 100, h: 105, l: 99, c: 101, v: 3 }];

  it('updates high, low and close inside the current bucket', () => {
    const c = base();
    expect(mergePrice(c, 107, 10 * M + 30_000, M)).toEqual({
      kind: 'update',
      candle: { t: 10 * M, o: 100, h: 107, l: 99, c: 107, v: 3 },
    });
    expect(mergePrice(c, 98, 10 * M + 40_000, M).kind).toBe('update');
    expect(c).toEqual([{ t: 10 * M, o: 100, h: 107, l: 98, c: 98, v: 3 }]);
  });

  it('opens a new bucket at the previous close', () => {
    const c = base();
    const r = mergePrice(c, 103, 11 * M + 1, M);
    expect(r).toEqual({ kind: 'append', candle: { t: 11 * M, o: 101, h: 103, l: 101, c: 103, v: 0 } });
    expect(c).toHaveLength(2);
  });

  it('starts a series from nothing', () => {
    const c: Candle[] = [];
    expect(mergePrice(c, 50, 3 * M + 5, M)).toEqual({ kind: 'append', candle: { t: 3 * M, o: 50, h: 50, l: 50, c: 50, v: 0 } });
  });

  it('ignores prices older than the last bar and bad values', () => {
    const c = base();
    expect(mergePrice(c, 90, 9 * M, M).kind).toBe('ignore');
    expect(mergePrice(c, Number.NaN, 10 * M, M).kind).toBe('ignore');
    expect(mergePrice(c, 0, 10 * M, M).kind).toBe('ignore');
    expect(c).toEqual(base());
  });
});
