import { describe, expect, it } from 'vitest';
import { OTC_OVERRIDE_HOLD_MS, OTC_OVERRIDE_LANDING_MS, OTC_OVERRIDE_RAMP_DEFAULT_MS } from '@traderoom/shared';
import { editedCandle, epochToLocalMinute, localMinuteToEpoch, phaseAt, priceScale, priceToY, projectedCandle, rampPlan, requiredSpeed, withLiveCandle, yToPrice } from './otc-override';

describe('withLiveCandle', () => {
  const hist = [
    { t: 0, o: 10, h: 11, l: 9, c: 10.5 },
    { t: 60_000, o: 10.5, h: 10.8, l: 10.2, c: 10.4 },
  ];
  it('updates the current candle when the server already has it', () => {
    const out = withLiveCandle(hist, 11.2, 60_000);
    expect(out.at(-1)).toEqual({ t: 60_000, o: 10.5, h: 11.2, l: 10.2, c: 11.2 });
    expect(hist[1]!.c).toBe(10.4);
  });
  it('opens a new candle from the previous close', () => {
    expect(withLiveCandle(hist, 10.1, 120_000).at(-1)).toEqual({ t: 120_000, o: 10.4, h: 10.4, l: 10.1, c: 10.1 });
  });
  it('keeps at most max candles', () => {
    expect(withLiveCandle(hist, 10, 120_000, 2).map((c) => c.t)).toEqual([60_000, 120_000]);
  });
});

describe('editedCandle', () => {
  it('closes on the target and stretches the wick to reach it', () => {
    expect(editedCandle({ t: 0, o: 10, h: 10.5, l: 9.8, c: 10.2 }, 11)).toEqual({ t: 0, o: 10, h: 11, l: 9.8, c: 11 });
    expect(editedCandle({ t: 0, o: 10, h: 10.5, l: 9.8, c: 10.2 }, 9)).toEqual({ t: 0, o: 10, h: 10.5, l: 9, c: 9 });
  });
});

describe('scale', () => {
  it('includes extra prices with margin and maps y back to price', () => {
    const s = priceScale([{ t: 0, o: 10, h: 11, l: 9, c: 10 }], [12, null])!;
    expect(s.max).toBeGreaterThan(12);
    expect(s.min).toBeLessThan(9);
    expect(yToPrice(s, 10, 300, priceToY(s, 10, 300, 10.37))).toBeCloseTo(10.37, 9);
  });
  it('a flat series still has height', () => {
    const s = priceScale([{ t: 0, o: 5, h: 5, l: 5, c: 5 }])!;
    expect(s.max).toBeGreaterThan(s.min);
  });
});

describe('ramp', () => {
  const close = 1_000_000;
  it('follows the server rule max(now, close − hold − landing − ramp)', () => {
    expect(rampPlan(0, close)).toEqual({
      rampStartMs: close - OTC_OVERRIDE_HOLD_MS - OTC_OVERRIDE_LANDING_MS - OTC_OVERRIDE_RAMP_DEFAULT_MS,
      holdStartMs: close - OTC_OVERRIDE_HOLD_MS,
      rampMs: OTC_OVERRIDE_RAMP_DEFAULT_MS,
    });
    expect(rampPlan(close - 9000, close).rampMs).toBe(9000 - OTC_OVERRIDE_HOLD_MS - OTC_OVERRIDE_LANDING_MS);
  });
  it('speed is distance over ramp time', () => {
    expect(requiredSpeed(100, 101, 8000)).toEqual({ pricePerSec: 0.125, pctPerSec: 0.125 });
    expect(requiredSpeed(100, 101, 0)).toBeNull();
  });
  it('phases', () => {
    const o = { rampStartMs: 100, holdStartMs: 200, candleCloseMs: 300 };
    expect([50, 150, 250, 300, 301].map((t) => phaseAt(t, o))).toEqual(['waiting', 'ramp', 'hold', 'hold', 'release']);
  });
});

describe('scheduled mode helpers', () => {
  it('turns a local HH:MM into the absolute epoch of its next occurrence', () => {
    const now = new Date(2026, 10, 8, 14, 30, 20).getTime();
    expect(localMinuteToEpoch('14:35', now)).toBe(new Date(2026, 10, 8, 14, 35).getTime());
    // Already passed today: tomorrow.
    expect(localMinuteToEpoch('14:30', now)).toBe(new Date(2026, 10, 9, 14, 30).getTime());
    expect(localMinuteToEpoch('25:00', now)).toBeNull();
    expect(localMinuteToEpoch('', now)).toBeNull();
    expect(localMinuteToEpoch('14:35', now)! % 60_000).toBe(0);
    expect(epochToLocalMinute(new Date(2026, 10, 8, 9, 5).getTime())).toBe('09:05');
  });

  it('projects the candle as open ± ticks on the price grid', () => {
    expect(projectedCandle(76_000, 'up', 20, 2)).toMatchObject({ o: 76_000, c: 76_000.2 });
    const down = projectedCandle(76_000, 'down', 15, 2);
    expect(down.c).toBe(75_999.85);
    expect(down.offsetPct).toBeCloseTo((0.15 / 76_000) * 100, 10);
  });
});
