import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts';
import type { Candle } from '@traderoom/shared';

/** Chart space (time, price) ↔ screen space (px) for the current frame, on the candles pane. */
export interface Mapper {
  toX(t: number): number;
  toT(x: number): number;
  toY(p: number): number | null;
  toP(y: number): number | null;
  logicalAt(x: number): number;
  w: number;
  h: number;
  candles: Candle[];
  lastIdx: number;
  spacing: number;
  xLast: number;
}

/**
 * Times map linearly from the last candle, so points between bars and in the future
 * (right of the last candle) land where they should; lightweight-charts only maps whole bars.
 */
export function createMapper(
  chart: IChartApi | null,
  series: ISeriesApi<'Candlestick'> | null,
  candles: Candle[] | null,
  step: number,
): Mapper | null {
  if (!chart || !series || !candles || candles.length === 0) return null;
  const ts = chart.timeScale();
  const lastIdx = candles.length - 1;
  const xLast = ts.logicalToCoordinate(lastIdx as Logical);
  if (xLast === null) return null;
  const xPrev = ts.logicalToCoordinate((lastIdx - 1) as Logical);
  const spacing = xPrev !== null && xLast !== xPrev ? xLast - xPrev : (ts.options().barSpacing ?? 6);
  const last = candles[lastIdx]!;
  return {
    toX: (t) => xLast + ((t - last.t) / step) * spacing,
    toT: (x) => last.t + ((x - xLast) / spacing) * step,
    toY: (p) => series.priceToCoordinate(p),
    toP: (y) => series.coordinateToPrice(y),
    logicalAt: (x) => lastIdx + (x - xLast) / spacing,
    w: ts.width(),
    h: chart.paneSize().height,
    candles,
    lastIdx,
    spacing,
    xLast,
  };
}
