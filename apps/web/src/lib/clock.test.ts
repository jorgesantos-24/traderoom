import { describe, expect, it } from 'vitest';
import { parseServerTime, ServerClock } from './clock';

describe('ServerClock', () => {
  it('starts at the local clock', () => {
    const c = new ServerClock(() => 1000);
    expect(c.serverNow()).toBe(1000);
  });

  it('takes the round-trip midpoint as the server instant', () => {
    let now = 10_000;
    const c = new ServerClock(() => now);
    // Local clock 5 s ahead: the server said 5_100 while we were between 10_000 and 10_200.
    c.observe(5_100, 10_000, 10_200);
    expect(c.offsetMs).toBe(-5000);
    now = 20_000;
    expect(c.serverNow()).toBe(15_000);
  });

  it('keeps the most precise sample and corrects for Date-header truncation', () => {
    const c = new ServerClock(() => 0);
    c.observe(1_000, 0, 100); // error 50
    c.observe(9_000, 0, 2000, 1000); // error 1500: ignored
    expect(c.offsetMs).toBe(950);
    const d = new ServerClock(() => 0);
    d.observe(2_000, 0, 0, 1000); // a Date of "2 s" means somewhere in [2000, 3000)
    expect(d.offsetMs).toBe(2500);
  });

  it('replaces an old sample even if the new one is less precise', () => {
    let now = 0;
    const c = new ServerClock(() => now, 1000);
    c.observe(100, 0, 0);
    now = 5000;
    c.observe(8000, 4000, 6000);
    expect(c.offsetMs).toBe(3000);
  });

  it('ignores nonsense samples', () => {
    const c = new ServerClock(() => 0);
    c.observe(Number.NaN, 0, 10);
    c.observe(5, 10, 0);
    expect(c.offsetMs).toBe(0);
  });
});

describe('parseServerTime', () => {
  it('parses microsecond ISO strings', () => {
    expect(parseServerTime('2026-11-06T15:00:00.123456Z')).toBe(Date.UTC(2026, 10, 6, 15, 0, 0, 123));
    expect(parseServerTime('2026-11-06T15:00:00Z')).toBe(Date.UTC(2026, 10, 6, 15));
    expect(parseServerTime('2026-11-06T15:00:00.5+00:00')).toBe(Date.UTC(2026, 10, 6, 15, 0, 0, 500));
  });
});
