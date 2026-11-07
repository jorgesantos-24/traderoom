import { describe, expect, it } from 'vitest';
import type { Candle } from '@traderoom/shared';
import { seedCandle, stepCandle } from './candle-motion';

const bar = (o: number, h: number, l: number, c: number, t = 60_000): Candle => ({ t, o, h, l, c, v: 0 });

describe('stepCandle', () => {
  it('moves part of the way toward the real close, not all of it', () => {
    const next = stepCandle(bar(100, 100, 100, 100), bar(100, 110, 100, 110), 16, 180, 1e-9);
    expect(next.c).toBeGreaterThan(100);
    expect(next.c).toBeLessThan(110);
    expect(next.h).toBeGreaterThanOrEqual(next.c);
  });

  it('reaches the target after enough frames and then stops changing', () => {
    const real = bar(100, 110, 95, 104);
    let shown = seedCandle(real);
    for (let i = 0; i < 200; i += 1) shown = stepCandle(shown, real, 16, 180, 1e-6);
    expect(shown).toEqual(real);
    expect(stepCandle(shown, real, 16, 180, 1e-6)).toBe(shown);
  });

  it('keeps the wick around the body while easing down', () => {
    const shown = bar(100, 100, 100, 100);
    const next = stepCandle(shown, bar(100, 100, 90, 90), 50, 180, 1e-9);
    expect(next.l).toBeLessThanOrEqual(next.c);
    expect(next.h).toBe(100);
  });

  it('snaps when animation is off (tau 0)', () => {
    const real = bar(100, 120, 99, 118);
    expect(stepCandle(bar(100, 100, 100, 100), real, 16, 0, 0)).toEqual(real);
  });

  it('jumps straight to a different bucket', () => {
    const real = bar(5, 6, 4, 5, 120_000);
    expect(stepCandle(bar(1, 1, 1, 1, 60_000), real, 16, 180, 0)).toEqual(real);
  });
});

describe('seedCandle', () => {
  it('starts flat at the open', () => {
    expect(seedCandle(bar(10, 12, 9, 11))).toEqual(bar(10, 10, 10, 10));
  });
});
