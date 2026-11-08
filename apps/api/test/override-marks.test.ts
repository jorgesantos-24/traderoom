import { describe, expect, it } from 'vitest';
import type { Candle } from '@traderoom/shared';
import { toMarks } from '../src/services/override-marks.js';

const MIN = 60_000;
const candle = (t: number, o: number): Candle => ({ t, o, h: o + 1, l: o - 1, c: o, v: 0 });

describe('toMarks', () => {
  const candles = [candle(0, 100), candle(MIN, 100), candle(2 * MIN, 100), candle(3 * MIN, 100)];

  it('marks only the candles that had an override, with direction from the open', () => {
    const marks = toMarks(
      [
        { candleOpenMs: MIN, candleCloseMs: 2 * MIN, targetPrice: 101 },
        { candleOpenMs: 3 * MIN, candleCloseMs: 4 * MIN, targetPrice: 99 },
      ],
      candles,
      '1m',
    );
    expect(marks).toEqual([
      { openMs: MIN, targetPrice: 101, direction: 'up' },
      { openMs: 3 * MIN, targetPrice: 99, direction: 'down' },
    ]);
  });

  it('puts the mark on the candle holding the close (a 5m override on a 1m chart)', () => {
    const marks = toMarks([{ candleOpenMs: 0, candleCloseMs: 4 * MIN, targetPrice: 100 }], candles, '1m');
    expect(marks).toEqual([{ openMs: 3 * MIN, targetPrice: 100, direction: 'flat' }]);
  });

  it('gives one mark per candle on longer intervals (latest close wins)', () => {
    const marks = toMarks(
      [
        { candleOpenMs: MIN, candleCloseMs: 2 * MIN, targetPrice: 90 },
        { candleOpenMs: 3 * MIN, candleCloseMs: 4 * MIN, targetPrice: 110 },
      ],
      [candle(0, 100)],
      '5m',
    );
    expect(marks).toEqual([{ openMs: 0, targetPrice: 110, direction: 'up' }]);
  });

  it('skips an override whose candle is not in the list', () => {
    expect(toMarks([{ candleOpenMs: 9 * MIN, candleCloseMs: 10 * MIN, targetPrice: 1 }], candles, '1m')).toEqual([]);
  });
});
