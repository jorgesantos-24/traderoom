import { describe, expect, it } from 'vitest';
import { Backoff } from '../src/lib/backoff.js';

describe('Backoff', () => {
  it('grows exponentially from 1 s and caps at 30 s (max jitter)', () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 30_000, random: () => 0.999999 });
    const delays = Array.from({ length: 8 }, () => b.next());
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
  });

  it('never goes below the base or below half of the exponential step (min jitter)', () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 30_000, random: () => 0 });
    const delays = Array.from({ length: 7 }, () => b.next());
    expect(delays).toEqual([1000, 1000, 2000, 4000, 8000, 15_000, 15_000]);
  });

  it('stays within [1 s, 30 s] with real randomness', () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 30_000 });
    for (let i = 0; i < 200; i++) {
      const d = b.next();
      expect(d).toBeGreaterThanOrEqual(1000);
      expect(d).toBeLessThanOrEqual(30_000);
    }
  });

  it('jitter spreads delays for the same attempt', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const b = new Backoff({ baseMs: 1000, maxMs: 30_000 });
      b.next();
      b.next();
      b.next();
      seen.add(b.next());
    }
    expect(seen.size).toBeGreaterThan(10);
  });

  it('reset() starts over and counts attempts', () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 30_000, random: () => 0.999999 });
    b.next();
    b.next();
    b.next();
    expect(b.attempts).toBe(3);
    b.reset();
    expect(b.attempts).toBe(0);
    expect(b.next()).toBe(1000);
  });

  it('does not overflow after a very long outage', () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 30_000, random: () => 0.5 });
    for (let i = 0; i < 10_000; i++) b.next();
    expect(b.next()).toBe(22_500);
  });
});
