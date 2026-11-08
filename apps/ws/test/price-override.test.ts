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

describe('PriceOverride, scheduled mode (market, 1m)', () => {
  /** The booked candle: [OPEN, CLOSE), the ramp from the open. */
  const OPEN = START;
  const FREEZE = OPEN + (LAND - OPEN) / 2;

  function scheduled(over: Partial<NonNullable<OtcOverrideWire['schedule']>> = {}, jitter = true): OtcOverrideWire {
    const { targetPrice: _drop, ...rest } = wire({ rampStartMs: OPEN, jitter });
    return { ...rest, schedule: { openMs: OPEN, direction: 'up', ticks: 20, maxOverridePct: 1, ...over } };
  }

  /** Flat real price, one tick every 250 ms; `price(t)` overrides it. */
  function drive(ov: PriceOverride, from: number, until: number, open: number, price: (t: number) => number = () => 76_000) {
    const out: Array<{ t: number; real: Tick; out: Tick }> = [];
    for (let t = from; t <= until; t += 250) {
      const p = price(t).toFixed(8);
      const r: Tick = { symbol: 'BTCUSDT', price: p, value: Number(p), ts: t - 15, recvMs: t - 3, provider: 'binance' };
      out.push({ t, real: r, out: ov.apply(r, t, ov.needsOpen(t) && !Number.isNaN(open) ? open : undefined) });
    }
    return out;
  }

  it('before the open every tick is raw: the previous candle closes on its own', () => {
    const ov = new PriceOverride(scheduled(), OPEN - 30_000, opts(1));
    expect(ov.needsOpen(OPEN - 1)).toBe(false);
    for (const s of drive(ov, OPEN - 30_000, OPEN - 1, 76_000, (t) => 76_000 + Math.sin(t / 900) * 3)) {
      expect(s.out).toEqual(s.real);
      expect(s.out.ov).toBeUndefined();
    }
    expect(ov.needsOpen(OPEN)).toBe(true);
    expect(Number.isNaN(ov.targetPrice)).toBe(true);
  });

  it('the target is derived from the open (the tick before the rollover), not from the first tick of the candle', () => {
    const saved: string[] = [];
    const ov = new PriceOverride(scheduled({ ticks: 20 }), OPEN - 5000, { ...opts(2), onTarget: (p) => saved.push(p) });
    drive(ov, OPEN - 5000, OPEN - 250, 0);
    // The first tick of the candle is 76 003, the open (last tick of the previous minute) 76 000.50.
    const first = ov.apply(
      { symbol: 'BTCUSDT', price: '76003.00000000', value: 76_003, ts: OPEN, recvMs: OPEN, provider: 'binance' },
      OPEN,
      76_000.5,
    );
    expect(first.ov).toBe('7');
    expect(ov.targetPrice).toBe(76_000.7);
    expect(ov.resolveTarget(76_000.5)).toBe(76_000.7);
    expect(ov.resolveTarget(50_000)).toBe(50_000.2);
    const steps = drive(ov, OPEN + 250, CLOSE, 0, () => 76_003);
    expect(saved).toEqual(['76000.70']);
    const atClose = steps.find((s) => s.t === CLOSE)!;
    expect(atClose.out.value).toBeGreaterThan(76_000.5);
  });

  it('down: open − ticks', () => {
    const ov = new PriceOverride(scheduled({ direction: 'down', ticks: 15 }), OPEN, opts(3));
    drive(ov, OPEN, OPEN, 76_000);
    expect(ov.targetPrice).toBe(75_999.85);
  });

  it('immediate mode: resolveTarget is the wire price, whatever the open', () => {
    const ov = new PriceOverride(wire(), START, opts(4));
    expect(ov.resolveTarget(1)).toBe(76_100);
    expect(ov.needsOpen(RAMP_START)).toBe(false);
  });

  it('the clamp shrinks the offset against max_override_pct in the first half of the ramp, then freezes', () => {
    const saved: string[] = [];
    // 500 ticks (5.00) on 76 000 with a 0.005% limit (3.80): clamped to 380 at the open.
    const ov = new PriceOverride(scheduled({ ticks: 500, maxOverridePct: 0.005 }), OPEN, { ...opts(5), onTarget: (p) => saved.push(p) });
    drive(ov, OPEN, OPEN, 76_000);
    expect(ov.bodyTicks).toBe(380);
    expect(ov.targetPrice).toBe(76_003.8);
    // The market falls 1.00 in the first half: 75 999 × 1.00005 − 76 000 = 2.79995 → 279 ticks.
    drive(ov, OPEN + 250, FREEZE - 1, 0, () => 75_999);
    expect(ov.bodyTicks).toBe(279);
    expect(ov.targetPrice).toBe(76_002.79);
    // It never grows back, and after the half nothing moves it.
    drive(ov, FREEZE, CLOSE, 0, (t) => (t < FREEZE + 5000 ? 76_000 : 75_990));
    expect(ov.bodyTicks).toBe(279);
    expect(saved).toEqual(['76002.79']);
  });

  it('with a body of a few ticks, the hold band stays under it: the close keeps the color on 200 seeds', () => {
    for (let k = 0; k < 200; k++) {
      for (const direction of ['up', 'down'] as const) {
        const ov = new PriceOverride(scheduled({ ticks: 10, direction }), OPEN, opts(1000 + k));
        // The market drifts 0.30 against the color through the candle.
        const sign = direction === 'up' ? -1 : 1;
        const steps = drive(ov, OPEN, CLOSE, 76_000, (t) => 76_000 + (sign * 0.3 * (t - OPEN)) / 60_000);
        const atClose = steps.find((s) => s.t === CLOSE)!.out.value;
        if (direction === 'up') expect(atClose, `seed ${k}`).toBeGreaterThan(76_000);
        else expect(atClose, `seed ${k}`).toBeLessThan(76_000);
      }
    }
  });

  it('ws restarted inside the candle (no bucketOpen): the persisted target wins over the first tick', () => {
    for (let k = 0; k < 50; k++) {
      const saved: string[] = [];
      const at = OPEN + 20_000;
      // Installed late, as after a restart: first tick 76 010, the persisted target 76 000.70.
      const ov = new PriceOverride(scheduled({ ticks: 20, maxOverridePct: 0.001 }), at, {
        ...opts(1500 + k),
        persistedTarget: 76_000.7,
        onTarget: (p) => saved.push(p),
      });
      const steps = drive(ov, at, CLOSE, Number.NaN, () => 76_010);
      expect(ov.targetPrice).toBe(76_000.7);
      // No open: the body is unknown, so the hold is exact; the close is where the mark points.
      expect(steps.find((s) => s.t === CLOSE)!.out.value).toBe(76_000.7);
      // Frozen already: no clamp (the 0.001% limit would have cut it), nothing saved again.
      expect(saved).toEqual([]);
    }
  });

  it('the persisted target is preferred even when the open is known', () => {
    const ov = new PriceOverride(scheduled({ ticks: 20 }), OPEN, { ...opts(7), persistedTarget: 76_000.4 });
    expect(ov.resolveTarget(76_000)).toBe(76_000.4);
    drive(ov, OPEN, OPEN, 76_000);
    expect(ov.targetPrice).toBe(76_000.4);
  });

  it('no bucketOpen and nothing persisted: falls back to the first tick', () => {
    const ov = new PriceOverride(scheduled({ ticks: 20 }), OPEN + 5000, opts(8));
    expect(ov.resolveTarget(undefined, 76_010)).toBe(76_010.2);
    drive(ov, OPEN + 5000, OPEN + 5000, Number.NaN, () => 76_010);
    expect(ov.targetPrice).toBe(76_010.2);
  });

  it('a body clamped to 1 tick holds exactly on the target (band 0): the color holds on 200 seeds', () => {
    for (let k = 0; k < 200; k++) {
      for (const direction of ['up', 'down'] as const) {
        // 0.000001% of 76 000 is 0.00076: no room at all, so the clamp floors the body at 1 tick.
        const ov = new PriceOverride(scheduled({ ticks: 50, direction, maxOverridePct: 0.000001 }), OPEN, opts(2000 + k));
        const steps = drive(ov, OPEN, CLOSE, 76_000);
        expect(ov.bodyTicks).toBe(1);
        const want = direction === 'up' ? 76_000.01 : 75_999.99;
        for (const s of steps.filter((x) => x.t >= LAND && x.t <= CLOSE)) expect(s.out.value, `seed ${k}`).toBe(want);
      }
    }
  });

  it('jitter: false lands exactly on the resolved target', () => {
    const ov = new PriceOverride(scheduled({ ticks: 25 }, false), OPEN, opts(6));
    const steps = drive(ov, OPEN, CLOSE, 76_000);
    expect(steps.find((s) => s.t === CLOSE)!.out.value).toBe(76_000.25);
  });
});
