import type { Candle } from '@traderoom/shared';

/**
 * How long the drawn candle takes to cover ~63% of the way to a new price. Ticks arrive a few
 * times per second, so ~0.26 s makes the body flow between them instead of jumping.
 */
export const MOTION_TAU_MS = 260;

/**
 * Moves the drawn (shown) candle one frame toward the real one. Close, high and low ease with
 * the same exponential curve, so the wick grows smoothly too; the open never moves. Once a value
 * is within `epsilon` it snaps, so the animation settles instead of crawling forever.
 * Returns the same object when nothing changed (the caller can skip the redraw).
 */
export function stepCandle(shown: Candle, real: Candle, dtMs: number, tauMs: number, epsilon: number): Candle {
  if (shown.t !== real.t) return { ...real };
  const k = tauMs <= 0 ? 1 : 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  const ease = (from: number, to: number) => {
    const next = from + (to - from) * k;
    return Math.abs(to - next) <= epsilon ? to : next;
  };
  const c = ease(shown.c, real.c);
  // The wick always contains the body, even mid-animation.
  const h = Math.max(ease(shown.h, real.h), c, shown.o);
  const l = Math.min(ease(shown.l, real.l), c, shown.o);
  if (c === shown.c && h === shown.h && l === shown.l) return shown;
  return { ...shown, o: real.o, c, h, l };
}

/** A freshly opened candle starts flat at its open and grows from there. */
export function seedCandle(real: Candle): Candle {
  return { ...real, h: real.o, l: real.o, c: real.o };
}
