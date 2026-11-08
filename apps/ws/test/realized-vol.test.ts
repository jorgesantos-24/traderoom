import { describe, expect, it } from 'vitest';
import { RealizedVol, VOL_BIAS, VOL_FLOOR, VOL_HALF_LIFE_S, VOL_MIN_SPAN_S, VOL_MIN_TICKS } from '../src/feed/realized-vol.js';

/** Repeatable normals and uniforms (xorshift). */
function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  const u = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) + 1) / 4294967297;
  };
  return { u, n: () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()) };
}

/** GBM with σ per √s, ticks at random intervals of mean `meanMs` (exponential). Returns the end time. */
function feed(v: RealizedVol, sigma: number, seconds: number, meanMs: number, seed: number, startMs = 0, startPrice = 76_000): number {
  const { u, n } = rng(seed);
  let t = startMs;
  let x = Math.log(startPrice);
  v.update(Math.exp(x), t);
  while (t < startMs + seconds * 1000) {
    const dt = Math.max(1, Math.round(-meanMs * Math.log(u())));
    t += dt;
    x += sigma * Math.sqrt(dt / 1000) * n();
    v.update(Math.exp(x), t);
  }
  return t;
}

const BTC = 0.005 / 60; // ~0.5%/h, per √s

describe('RealizedVol', () => {
  it('is null below the minimum ticks or the minimum span', () => {
    const fewTicks = new RealizedVol();
    for (let i = 0; i < VOL_MIN_TICKS - 1; i++) fewTicks.update(76_000 + (i % 2), i * 5000);
    expect(fewTicks.sigma()).toBeNull();

    const shortSpan = new RealizedVol();
    for (let i = 0; i < 200; i++) shortSpan.update(76_000 + (i % 2), i * 100); // 20 s of data
    expect((200 * 100) / 1000).toBeLessThan(VOL_MIN_SPAN_S);
    expect(shortSpan.sigma()).toBeNull();
  });

  it('recovers σ per √s from irregular ticks, whatever the tick rate (decay is by time)', () => {
    for (const meanMs of [50, 250, 2000]) {
      const v = new RealizedVol();
      feed(v, BTC, 900, meanMs, 7);
      const est = v.sigma();
      expect(est, `mean ${meanMs} ms`).not.toBeNull();
      expect(est! / VOL_BIAS / BTC).toBeGreaterThan(0.85);
      expect(est! / VOL_BIAS / BTC).toBeLessThan(1.15);
    }
  });

  it('leans high by exactly VOL_BIAS (30%): noise-free input gives 1.3× the true σ', () => {
    expect(VOL_BIAS).toBe(1.3);
    // ±r every dt: r²/dt is the same on every sample, so the EWMA is exact.
    const v = new RealizedVol();
    const r = 1e-4;
    let p = 76_000;
    for (let i = 0; i <= 100; i++) {
      v.update(p, i * 1000);
      p *= Math.exp(i % 2 ? -r : r);
    }
    expect(v.sigma()! / r).toBeCloseTo(VOL_BIAS, 9);
  });

  it('never reports below the injected σ, on 200 seeds and every tick rate', () => {
    for (const meanMs of [50, 250, 2000]) {
      let lowest = Infinity;
      let sum = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const v = new RealizedVol();
        feed(v, BTC, 900, meanMs, seed);
        const ratio = v.sigma()! / BTC;
        lowest = Math.min(lowest, ratio);
        sum += ratio;
      }
      expect(lowest, `mean ${meanMs} ms`).toBeGreaterThanOrEqual(1);
      // On average 30% above; single seeds spread with the sampling noise (wider on quiet symbols).
      expect(sum / 200 / VOL_BIAS).toBeGreaterThan(0.95);
      expect(sum / 200 / VOL_BIAS).toBeLessThan(1.05);
    }
  });

  it('forgets with a ~120 s half-life: halfway (in variance) one half-life after a regime change', () => {
    const v = new RealizedVol();
    const t = feed(v, BTC, 900, 100, 3);
    feed(v, 3 * BTC, VOL_HALF_LIFE_S, 100, 4, t + 100, 76_000);
    const var1 = BTC ** 2;
    const var2 = (3 * BTC) ** 2;
    const mid = (var1 + var2) / 2;
    const got = (v.sigma()! / VOL_BIAS) ** 2;
    expect(got / mid).toBeGreaterThan(0.75);
    expect(got / mid).toBeLessThan(1.25);
  });

  it('one isolated spike is clamped: it cannot multiply the estimate', () => {
    const v = new RealizedVol();
    const t = feed(v, BTC, 600, 100, 5);
    const before = v.sigma()!;
    // A 1% print 100 ms later (a book spike), then back.
    v.update(76_000 * 1.01, t + 100);
    const after = v.sigma()!;
    // Unclamped, r²/dt = 1e-4/0.1 = 1e-3 per s, ~5e5 times BTC's variance; the EWMA weight of 100 ms
    // (~5.8e-4) would still lift σ ~17x. Clamped at 4σ it moves by well under 1%.
    expect(after / before).toBeLessThan(1.01);
  });

  it('never reports zero, and recovers after a flat stretch', () => {
    const v = new RealizedVol();
    for (let i = 0; i < 600; i++) v.update(76_000, i * 500);
    expect(v.sigma()).toBe(VOL_FLOOR);
    feed(v, BTC, 900, 100, 9, 600 * 500, 76_000);
    expect(v.sigma()! / VOL_BIAS / BTC).toBeGreaterThan(0.8);
  });

  it('ignores same-ms ticks (the next return covers them) and bad prices', () => {
    const a = new RealizedVol();
    const b = new RealizedVol();
    for (let i = 0; i < 100; i++) {
      const p = 76_000 + Math.sin(i) * 5;
      a.update(p, i * 1000);
      b.update(p, i * 1000);
      b.update(p + 50, i * 1000); // same instant: dropped
      b.update(NaN, i * 1000 + 1);
      b.update(-1, i * 1000 + 2);
    }
    expect(b.sigma()).toBeCloseTo(a.sigma()!, 12);
  });
});
