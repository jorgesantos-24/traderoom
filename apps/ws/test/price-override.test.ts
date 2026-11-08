import { describe, expect, it } from 'vitest';
import {
  OTC_OVERRIDE_HOLD_MS,
  OTC_OVERRIDE_LANDING_MS,
  OTC_OVERRIDE_RELEASE_MS,
  otcOverrideRampStartMs,
  type OtcOverrideWire,
} from '@traderoom/shared';
import { BAND_FRACTION, BAND_MIN_TICKS } from '../src/feed/override-path.js';
import { PriceOverride } from '../src/feed/price-override.js';
import type { Tick } from '../src/feed/types.js';

const CLOSE = 1_800_000_060_000;
const START = CLOSE - 60_000;
const RAMP_MS = 40_000;
const RAMP_START = otcOverrideRampStartMs(START, CLOSE, RAMP_MS);
const HOLD_START = CLOSE - OTC_OVERRIDE_HOLD_MS;
const LAND = HOLD_START - OTC_OVERRIDE_LANDING_MS;
const RELEASE_END = CLOSE + OTC_OVERRIDE_RELEASE_MS;

function wire(over: Partial<OtcOverrideWire> = {}): OtcOverrideWire {
  return {
    id: '7',
    kind: 'market',
    symbol: 'BTCUSDT',
    targetPrice: '76100.00',
    basePrice: '76000.00',
    closeMs: CLOSE,
    rampStartMs: RAMP_START,
    holdMs: OTC_OVERRIDE_HOLD_MS,
    releaseMs: OTC_OVERRIDE_RELEASE_MS,
    ...over,
  };
}

/** Repeatable normals (xorshift + Box–Muller). */
function seeded(seed = 42) {
  let s = seed >>> 0 || 1;
  const u = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) + 1) / 4294967297;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/** assets.price_decimals of BTCUSDT, and BTC's realized vol (~0.5%/h) per √s. */
const DECIMALS = 2;
const TICK = 0.01;
const BTC_VOL = 0.005 / 60;
const opts = (seed: number, volPerSqrtS: number | null = BTC_VOL) => ({ decimals: DECIMALS, volPerSqrtS, normal: seeded(seed) });

/** A real Binance-like tick: the market wanders a little around 76 000. */
function real(at: number): Tick {
  const p = (76_000 + Math.sin(at / 7000) * 20).toFixed(8);
  return { symbol: 'BTCUSDT', price: p, value: Number(p), ts: at - 15, recvMs: at - 3, provider: 'binance' };
}

/** One tick every 250 ms from START to `until`, plus the given extra times. */
function run(ov: PriceOverride, until: number, extra: number[] = []) {
  const times = new Set(extra);
  for (let t = START; t <= until; t += 250) times.add(t);
  return [...times]
    .sort((a, b) => a - b)
    .map((t) => {
      const r = real(t);
      return { t, real: r, out: ov.apply(r, t) };
    });
}

describe('PriceOverride', () => {
  it('leaves the price natural before the ramp', () => {
    const ov = new PriceOverride(wire(), START);
    for (const s of run(ov, RAMP_START - 1)) {
      expect(s.out).toEqual(s.real);
      expect(s.out.ov).toBeUndefined();
    }
  });

  it('jitter: false reaches the target at holdStart - LANDING and holds it exactly to the close', () => {
    const ov = new PriceOverride(wire({ jitter: false }), START);
    const steps = run(ov, CLOSE, [LAND, LAND - 1, HOLD_START, CLOSE]);
    const landed = steps.filter((s) => s.t >= LAND && s.t <= CLOSE);
    expect(landed.length).toBeGreaterThan(10);
    for (const s of landed) {
      expect(s.out.value).toBe(76_100);
      expect(Number(s.out.price)).toBe(76_100);
      expect(s.out.ov).toBe('7');
      expect(s.out.realPrice).toBe(s.real.price);
    }
    // Just before landing it is already close (easeOut has no noise to keep it off the target).
    const before = steps.find((s) => s.t === LAND - 1);
    expect(Math.abs((before?.out.value ?? 0) - 76_100)).toBeLessThan(1);
  });

  it('moves gradually on the ramp, with no jump at its start', () => {
    const ov = new PriceOverride(wire({ jitter: false }), START);
    const ramp = run(ov, LAND - 1).filter((s) => s.t >= RAMP_START);
    const first = ramp[0];
    expect(first?.out.value).toBeCloseTo(first?.real.value ?? 0, 6);
    for (let i = 1; i < ramp.length; i++) {
      const prev = ramp[i - 1]?.out.value ?? 0;
      const cur = ramp[i]?.out.value ?? 0;
      // Without jitter the path climbs to the target monotonically, a few dollars per step at most.
      expect(cur).toBeGreaterThanOrEqual(prev - 1e-6);
      expect(cur - prev).toBeLessThan(5);
    }
  });

  it('keeps ts and recvMs of the real tick', () => {
    const ov = new PriceOverride(wire(), START);
    for (const s of run(ov, RELEASE_END + 1000, [CLOSE])) {
      expect(s.out.ts).toBe(s.real.ts);
      expect(s.out.recvMs).toBe(s.real.recvMs);
      expect(s.out.provider).toBe(s.real.provider);
    }
  });

  it('eases back to the real price after the close and is done at release end', () => {
    const ov = new PriceOverride(wire(), START, opts(3));
    const steps = run(ov, RELEASE_END + 2000, [CLOSE, CLOSE + 1, RELEASE_END - 1, RELEASE_END]);
    // Starts from the hold (within the band of the target), not from the real price.
    const justAfter = steps.find((s) => s.t === CLOSE + 1);
    expect(Math.abs((justAfter?.out.value ?? 0) - 76_100)).toBeLessThan(BAND_FRACTION * 120);
    const lastRelease = steps.find((s) => s.t === RELEASE_END - 1);
    expect(Math.abs((lastRelease?.out.value ?? 0) - (lastRelease?.real.value ?? 0))).toBeLessThan(76_100 * 0.0002 + 0.01);
    expect(ov.done).toBe(true);
    for (const s of steps.filter((x) => x.t >= RELEASE_END)) expect(s.out).toEqual(s.real);
  });

  it('is not done before release end', () => {
    const ov = new PriceOverride(wire(), START);
    run(ov, RELEASE_END - 1);
    expect(ov.done).toBe(false);
  });

  it('read after the release is already over: done at once, never touches a price', () => {
    const ov = new PriceOverride(wire(), RELEASE_END + 10);
    expect(ov.done).toBe(true);
    const r = real(RELEASE_END + 20);
    expect(ov.apply(r, RELEASE_END + 20)).toEqual(r);
  });

  it('read late, the ramp starts now instead of half done', () => {
    const late = RAMP_START + 20_000;
    const ov = new PriceOverride(wire({ jitter: false }), late);
    const r = real(late);
    expect(ov.apply(r, late).value).toBeCloseTo(r.value, 6);
  });
});

describe('PriceOverride with OverridePath', () => {
  const UP = '76097.00';
  const DOWN = '75903.00';

  /** Ticks every 250 ms shifted by `phase`, plus one exactly at landMs and at the close. */
  function path(target: string, seed: number, phase = 0, volPerSqrtS: number | null = BTC_VOL) {
    const ov = new PriceOverride(wire({ targetPrice: target }), START, opts(seed, volPerSqrtS));
    const times = new Set([LAND, CLOSE]);
    for (let t = START + phase; t <= RELEASE_END + 1000; t += 250) times.add(t);
    const steps = [...times]
      .sort((a, b) => a - b)
      .map((t) => {
        const r = real(t);
        return { t, real: r, out: ov.apply(r, t) };
      });
    const ramp = steps.filter((s) => s.t >= RAMP_START && s.t < LAND);
    const x0 = ramp[0]!.real.value;
    // Same rule as OverridePath: 10% of the body, on the price_decimals grid, floor of 2 ticks.
    const bandTicks = Math.max(BAND_MIN_TICKS, Math.round((BAND_FRACTION * Math.abs(Number(target) - x0)) / TICK));
    return {
      ov,
      steps,
      ramp,
      hold: steps.filter((s) => s.t >= LAND && s.t <= CLOSE),
      atClose: steps.find((s) => s.t === CLOSE)!,
      band: bandTicks * TICK,
      bandTicks,
    };
  }

  const onGrid = (v: number) => Math.abs(v / TICK - Math.round(v / TICK)) < 1e-6;

  it('direction is guaranteed on 200 seeds: up closes above the open, down below', () => {
    for (let k = 0; k < 200; k++) {
      for (const target of [UP, DOWN]) {
        const { steps, atClose } = path(target, 100 + k, (k * 37) % 250);
        const open = steps[0]!.out.value;
        if (target === UP) expect(atClose.out.value, `seed ${k}`).toBeGreaterThan(open);
        else expect(atClose.out.value, `seed ${k}`).toBeLessThan(open);
      }
    }
  });

  it('the first ramp tick is the real price; the ramp ends at landMs, exactly on the target', () => {
    for (let k = 0; k < 50; k++) {
      for (const target of [UP, DOWN]) {
        const { ramp, steps } = path(target, 300 + k, (k * 53) % 250);
        expect(ramp[0]!.out.value).toBeCloseTo(ramp[0]!.real.value, 2);
        expect(steps.find((s) => s.t === LAND)!.out.value).toBe(Number(target));
        // The last ramp tick is still on its way, at least a tick from the target.
        expect(Math.abs(ramp.at(-1)!.out.value - Number(target))).toBeGreaterThan(0);
      }
    }
  });

  it('no stretch of the ramp is linear for more than 3 ticks', () => {
    for (let k = 0; k < 200; k++) {
      const { ramp } = path(k % 2 ? UP : DOWN, 500 + k, (k * 41) % 250);
      const v = ramp.map((s) => s.out.value);
      let run = 2;
      for (let i = 2; i < v.length; i++) {
        const same = Math.abs(v[i]! - v[i - 1]! - (v[i - 1]! - v[i - 2]!)) <= TICK + 1e-9;
        run = same ? run + 1 : 2;
        expect(run, `seed ${k}, tick ${i}`).toBeLessThanOrEqual(3);
      }
    }
  });

  it('the hold never repeats a price, never leaves the band, closes inside [target ± band], on the grid', () => {
    for (let k = 0; k < 200; k++) {
      for (const target of [UP, DOWN]) {
        const { hold, atClose, band, bandTicks } = path(target, 700 + k, (k * 29) % 250);
        // A 97-point body at 2 decimals: ~9.7 of band, far above the 2-tick floor.
        expect(bandTicks).toBeGreaterThan(5 * BAND_MIN_TICKS);
        expect(hold.length).toBeGreaterThan(10);
        for (let i = 1; i < hold.length; i++) expect(hold[i]!.out.value, `seed ${k}, tick ${i}`).not.toBe(hold[i - 1]!.out.value);
        for (const s of hold) {
          expect(Math.abs(s.out.value - Number(target))).toBeLessThanOrEqual(band + 1e-9);
          expect(onGrid(s.out.value)).toBe(true);
          // Downstream expects the provider's 8-decimal text.
          expect(s.out.price).toMatch(/^\d+\.\d{8}$/);
          expect(s.out.realPrice).toBe(s.real.price);
        }
        expect(Math.abs(atClose.out.value - Number(target))).toBeLessThanOrEqual(band + 1e-9);
      }
    }
  });

  it('the release still converges to the real price and hands back the real ticks', () => {
    for (let k = 0; k < 50; k++) {
      const { ov, steps } = path(k % 2 ? UP : DOWN, 900 + k);
      const lastRelease = steps.filter((s) => s.t > CLOSE && s.t < RELEASE_END).at(-1)!;
      expect(Math.abs(lastRelease.out.value - lastRelease.real.value)).toBeLessThan(lastRelease.real.value * 0.0002 + 0.01);
      for (const s of steps.filter((x) => x.t >= RELEASE_END)) expect(s.out).toEqual(s.real);
      expect(ov.done).toBe(true);
    }
  });

  it('without a volatility estimate the ramp uses the body-derived sigma and keeps every rule', () => {
    const { ramp, hold, atClose, band } = path(UP, 11, 0, null);
    expect(ramp.length).toBeGreaterThan(100);
    expect(hold.length).toBeGreaterThan(10);
    expect(Math.abs(atClose.out.value - Number(UP))).toBeLessThanOrEqual(band + 1e-9);
  });
});
