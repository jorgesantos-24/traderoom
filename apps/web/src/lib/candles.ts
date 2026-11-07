import type { Candle, CandleInterval } from '@traderoom/shared';

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function intervalMs(interval: CandleInterval): number {
  const unit = interval.at(-1) as keyof typeof UNIT_MS;
  return Number(interval.slice(0, -1)) * UNIT_MS[unit];
}

export function bucketStart(ts: number, stepMs: number): number {
  return Math.floor(ts / stepMs) * stepMs;
}

export type MergeResult =
  | { kind: 'update'; candle: Candle }
  | { kind: 'append'; candle: Candle }
  | { kind: 'ignore' };

/**
 * Folds one price into the series. Mutates `candles` (last item replaced or a new one pushed)
 * and says what changed, so the chart can call `series.update` with just that bar.
 * Prices older than the last bar are ignored: the chart cannot rewrite history.
 */
export function mergePrice(candles: Candle[], price: number, ts: number, stepMs: number): MergeResult {
  if (!Number.isFinite(price) || price <= 0) return { kind: 'ignore' };
  const t = bucketStart(ts, stepMs);
  const last = candles.at(-1);
  if (last && t < last.t) return { kind: 'ignore' };
  if (last && t === last.t) {
    const candle: Candle = { ...last, h: Math.max(last.h, price), l: Math.min(last.l, price), c: price };
    candles[candles.length - 1] = candle;
    return { kind: 'update', candle };
  }
  // A new bucket opens where the previous one closed, so there is no visual gap between bars.
  const open = last ? last.c : price;
  const candle: Candle = { t, o: open, h: Math.max(open, price), l: Math.min(open, price), c: price, v: 0 };
  candles.push(candle);
  return { kind: 'append', candle };
}
