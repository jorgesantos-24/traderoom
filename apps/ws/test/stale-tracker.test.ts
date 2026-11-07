import { describe, expect, it } from 'vitest';
import { StaleTracker } from '../src/feed/stale-tracker.js';

const T0 = 5_000_000;

describe('StaleTracker', () => {
  it('starts stale without emitting, recovers on the first tick', () => {
    const s = new StaleTracker(2000, ['BTCUSDT']);
    expect(s.isStale('BTCUSDT')).toBe(true);
    expect(s.evaluate(T0)).toEqual([]);
    expect(s.seen('BTCUSDT', T0)).toEqual({ symbol: 'BTCUSDT', on: false });
    expect(s.isStale('BTCUSDT')).toBe(false);
    expect(s.seen('BTCUSDT', T0 + 10)).toBeNull();
  });

  it('goes stale strictly after 2000 ms of silence, once', () => {
    const s = new StaleTracker(2000, ['BTCUSDT']);
    s.seen('BTCUSDT', T0);
    expect(s.evaluate(T0 + 2000)).toEqual([]);
    expect(s.evaluate(T0 + 2001)).toEqual([{ symbol: 'BTCUSDT', on: true }]);
    expect(s.evaluate(T0 + 3000)).toEqual([]);
    expect(s.isStale('BTCUSDT')).toBe(true);
    expect(s.seen('BTCUSDT', T0 + 3500)).toEqual({ symbol: 'BTCUSDT', on: false });
  });

  it('tracks symbols independently', () => {
    const s = new StaleTracker(2000, ['BTCUSDT', 'ETHUSDT']);
    s.seen('BTCUSDT', T0);
    s.seen('ETHUSDT', T0 + 1500);
    expect(s.evaluate(T0 + 2500)).toEqual([{ symbol: 'BTCUSDT', on: true }]);
    expect(s.isStale('ETHUSDT')).toBe(false);
    expect(s.ageMs('ETHUSDT', T0 + 2500)).toBe(1000);
  });

  it('ignores unknown symbols and treats them as stale', () => {
    const s = new StaleTracker(2000, ['BTCUSDT']);
    expect(s.seen('XYZUSDT', T0)).toBeNull();
    expect(s.isStale('XYZUSDT')).toBe(true);
    expect(s.ageMs('XYZUSDT', T0)).toBeNull();
  });

  it('does not move the clock backwards on an older receive time', () => {
    const s = new StaleTracker(2000, ['BTCUSDT']);
    s.seen('BTCUSDT', T0 + 1000);
    s.seen('BTCUSDT', T0);
    expect(s.evaluate(T0 + 2500)).toEqual([]);
  });

  it('adds new symbols as stale and drops removed ones', () => {
    const s = new StaleTracker(2000, ['BTCUSDT']);
    s.seen('BTCUSDT', T0);
    s.setSymbols(['BTCUSDT', 'SOLUSDT']);
    expect(s.isStale('BTCUSDT')).toBe(false);
    expect(s.isStale('SOLUSDT')).toBe(true);
    s.setSymbols(['SOLUSDT']);
    expect(s.ageMs('BTCUSDT', T0)).toBeNull();
  });
});
