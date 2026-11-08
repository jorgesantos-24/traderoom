import { describe, expect, it } from 'vitest';
import {
  OTC_OVERRIDE_HOLD_MS,
  OTC_OVERRIDE_LANDING_MS,
  OTC_OVERRIDE_RELEASE_MS,
  otcOverrideRampStartMs,
  type OtcOverrideWire,
} from '@traderoom/shared';
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

  it('reaches the target at holdStart - LANDING and holds it exactly to the close', () => {
    const ov = new PriceOverride(wire(), START);
    const steps = run(ov, CLOSE, [LAND, LAND - 1, HOLD_START, CLOSE]);
    const landed = steps.filter((s) => s.t >= LAND && s.t <= CLOSE);
    expect(landed.length).toBeGreaterThan(10);
    for (const s of landed) {
      expect(s.out.value).toBe(76_100);
      expect(Number(s.out.price)).toBe(76_100);
      expect(s.out.ov).toBe('7');
      expect(s.out.realPrice).toBe(s.real.price);
    }
    // Just before landing it is close but not yet there.
    const before = steps.find((s) => s.t === LAND - 1);
    expect(before?.out.value).not.toBe(76_100);
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

  it('jitter stays small and fades out on arrival', () => {
    const plain = new PriceOverride(wire({ jitter: false }), START);
    const noisy = new PriceOverride(wire(), START, () => 1);
    for (let t = RAMP_START; t < LAND; t += 250) {
      const a = plain.apply(real(t), t).value;
      const b = noisy.apply(real(t), t).value;
      const p = (t - RAMP_START) / (LAND - RAMP_START);
      expect(Math.abs(b - a)).toBeLessThanOrEqual(76_100 * 0.0001 * (1 - p) + 0.01);
    }
    expect(noisy.apply(real(LAND), LAND).value).toBe(76_100);
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
    const ov = new PriceOverride(wire(), START);
    const steps = run(ov, RELEASE_END + 2000, [CLOSE, CLOSE + 1, RELEASE_END - 1, RELEASE_END]);
    const justAfter = steps.find((s) => s.t === CLOSE + 1);
    expect(justAfter?.out.value).toBeCloseTo(76_100, 0);
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
