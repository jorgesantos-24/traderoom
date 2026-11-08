import { describe, expect, it } from 'vitest';
import {
  OTC_OVERRIDE_HOLD_MS,
  OTC_OVERRIDE_LANDING_MS,
  OTC_OVERRIDE_RELEASE_MS,
  otcOverrideRampStartMs,
  type OtcOverrideWire,
} from '@traderoom/shared';
import { OtcWalk } from '../src/feed/otc.js';
import { BAND_FRACTION, BAND_MIN_TICKS, OverridePath, SIGMA_FACTOR } from '../src/feed/override-path.js';

/** Repeatable normals for tests (xorshift + Box–Muller). */
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

const TICK_MS = 500;
/** Per √second, from %/hour (same conversion as OtcWalk). */
const volPerSqrtS = (pctHour: number) => pctHour / 100 / 60;

interface Case {
  x0: number;
  target: number;
  decimals: number;
  volPctHour: number;
  rampMs: number;
}

/** Drives an OverridePath every TICK_MS (shifted by `phase`) from start to close, plus a tick exactly at the close. */
function drive(c: Case, normal: () => number, phase = 0) {
  const landMs = c.rampMs;
  const closeMs = landMs + OTC_OVERRIDE_LANDING_MS + OTC_OVERRIDE_HOLD_MS;
  const path = new OverridePath({
    x0: Math.log(c.x0),
    targetX: Math.log(c.target),
    startMs: 0,
    landMs,
    volPerSqrtS: volPerSqrtS(c.volPctHour),
    decimals: c.decimals,
    normal,
  });
  const times = new Set<number>([closeMs]);
  for (let t = phase; t <= closeMs; t += TICK_MS) if (t > 0) times.add(t);
  const ramp: number[] = [c.x0];
  const hold: number[] = [];
  let close = NaN;
  for (const t of [...times].sort((a, b) => a - b)) {
    const p = Number(Math.exp(path.step(t)).toFixed(c.decimals));
    if (t < landMs) ramp.push(p);
    else hold.push(p);
    if (t === closeMs) close = p;
  }
  return { path, ramp, hold, close };
}

const diffs = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]!);

function signChanges(xs: number[]): number {
  const s = diffs(xs)
    .map(Math.sign)
    .filter((d) => d !== 0);
  return s.slice(1).filter((d, i) => d !== s[i]).length;
}

/** Longest run of ticks lying on one straight line (equal steps, within one tick). */
function longestLinear(xs: number[], tick: number): number {
  const d = diffs(xs);
  let best = Math.min(xs.length, 2);
  let run = 2;
  for (let i = 1; i < d.length; i++) {
    run = Math.abs(d[i]! - d[i - 1]!) <= tick + 1e-12 ? run + 1 : 2;
    best = Math.max(best, run);
  }
  return best;
}

const BTC_UP: Case = { x0: 76_000, target: 76_450, decimals: 2, volPctHour: 0.8, rampMs: 8000 };

describe('OverridePath', () => {
  it('exports its tuning constants', () => {
    expect(SIGMA_FACTOR).toBe(0.1);
    expect(BAND_FRACTION).toBeGreaterThan(0);
    expect(BAND_MIN_TICKS).toBeGreaterThanOrEqual(2);
  });

  it('a long ramp (60 s) has at least 3 sign inversions, on every seed', () => {
    let fewest = Infinity;
    for (let k = 0; k < 200; k++) {
      for (const target of [76_450, 75_550]) {
        const { ramp } = drive({ ...BTC_UP, target, rampMs: 60_000 }, seeded(100 + k), k % TICK_MS);
        fewest = Math.min(fewest, signChanges(ramp));
      }
    }
    expect(fewest).toBeGreaterThanOrEqual(3);
  });

  it('no stretch of the ramp is linear for more than 3 ticks (8 s and 60 s ramps)', () => {
    for (const rampMs of [8000, 60_000]) {
      for (let k = 0; k < 200; k++) {
        const { ramp } = drive({ ...BTC_UP, rampMs, target: k % 2 ? 76_450 : 75_550 }, seeded(400 + k), (k * 37) % TICK_MS);
        expect(longestLinear(ramp, 0.01), `ramp ${rampMs}, seed ${k}`).toBeLessThanOrEqual(3);
      }
    }
  });

  it('the hold never repeats a price, never leaves the band, and closes inside [target ± band]', () => {
    const cases: Case[] = [
      BTC_UP,
      { ...BTC_UP, target: 75_550 },
      // Band between the clamps: 10% of a 0.01 body at 4 decimals is 10 ticks.
      { x0: 0.18, target: 0.19, decimals: 4, volPctHour: 1.4, rampMs: 8000 },
      // Tiny body: the band is held at the minimum.
      { x0: 0.18, target: 0.1803, decimals: 4, volPctHour: 1.4, rampMs: 3000 },
    ];
    const bands = new Set<number>();
    for (const c of cases) {
      for (let k = 0; k < 200; k++) {
        const { path, hold, close } = drive(c, seeded(900 + k), (k * 53) % TICK_MS);
        const band = path.bandPrice;
        bands.add(path.bandTicks);
        // Landing tick plus every tick of landing + hold.
        expect(hold.length).toBeGreaterThanOrEqual(8);
        for (let i = 1; i < hold.length; i++) expect(hold[i], `case ${c.target}, seed ${k}, tick ${i}`).not.toBe(hold[i - 1]);
        for (const p of hold) expect(Math.abs(p - c.target)).toBeLessThanOrEqual(band + 1e-9);
        expect(Math.abs(close - c.target)).toBeLessThanOrEqual(band + 1e-9);
      }
    }
    // No ceiling: a 450 body at 2 decimals is a 4500-tick band.
    expect(bands).toEqual(new Set([4500, 10, BAND_MIN_TICKS]));
  });

  it('a ramp pushed hard against its direction is reflected at the start (1 tick of slack)', () => {
    for (const [target, push] of [
      [76_450, -50],
      [75_550, 50],
    ] as const) {
      const { ramp } = drive({ ...BTC_UP, target }, () => push);
      const up = target > BTC_UP.x0;
      for (const p of ramp) {
        if (up) expect(p).toBeGreaterThanOrEqual(BTC_UP.x0 - 0.01 - 0.005);
        else expect(p).toBeLessThanOrEqual(BTC_UP.x0 + 0.01 + 0.005);
      }
    }
  });
});

describe('OtcWalk with OverridePath', () => {
  const BTC = { startPrice: 76_000, volPctHour: 0.8, decimals: 2 };
  const CLOSE = 1_800_000_060_000;
  /** The candle open: the walk starts exactly there. */
  const OPEN = CLOSE - 60_000;

  function wire(target: string, over: Partial<OtcOverrideWire> = {}): OtcOverrideWire {
    return {
      symbol: 'BTCOTC',
      targetPrice: target,
      basePrice: '76000.00',
      closeMs: CLOSE,
      rampStartMs: otcOverrideRampStartMs(OPEN, CLOSE),
      holdMs: OTC_OVERRIDE_HOLD_MS,
      releaseMs: OTC_OVERRIDE_RELEASE_MS,
      ...over,
    };
  }

  function run(w: OtcWalk, until: number) {
    const out: Array<{ t: number; p: number }> = [{ t: OPEN, p: Number(w.format()) }];
    let last = OPEN;
    for (let t = OPEN + TICK_MS; t <= until; t += TICK_MS) {
      out.push({ t, p: Number(w.format(w.step((t - last) / 1000, t))) });
      last = t;
    }
    return out;
  }

  it('an up override closes above the open and a down one below, on 200 seeds, within the band of the target', () => {
    for (const [target, up] of [
      ['76450.00', true],
      ['75550.00', false],
    ] as const) {
      for (let k = 0; k < 200; k++) {
        const w = new OtcWalk(BTC, 76_000, seeded(2000 + k));
        w.setOverride(wire(target), OPEN);
        const ticks = run(w, CLOSE);
        const open = ticks[0]!.p;
        const close = ticks.at(-1)!.p;
        expect(ticks.at(-1)!.t).toBe(CLOSE);
        if (up) expect(close).toBeGreaterThan(open);
        else expect(close).toBeLessThan(open);
        // Band from the body as the ramp saw it: x0 is the last price shown before the ramp start.
        const x0 = ticks.filter((x) => x.t < otcOverrideRampStartMs(OPEN, CLOSE)).at(-1)!.p;
        const band = Math.max(BAND_MIN_TICKS * 0.01, BAND_FRACTION * Math.abs(Number(target) - x0));
        expect(Math.abs(close - Number(target))).toBeLessThanOrEqual(band + 0.01 + 1e-9);
      }
    }
  });

  it('the hold is never flat: consecutive ticks from landing to close all differ', () => {
    for (let k = 0; k < 50; k++) {
      const w = new OtcWalk(BTC, 76_000, seeded(3000 + k));
      w.setOverride(wire('76450.00'), OPEN);
      const hold = run(w, CLOSE).filter((x) => x.t >= CLOSE - OTC_OVERRIDE_HOLD_MS - OTC_OVERRIDE_LANDING_MS);
      for (let i = 1; i < hold.length; i++) expect(hold[i]!.p).not.toBe(hold[i - 1]!.p);
    }
  });

  it('jitter: false keeps the legacy flat hold on the exact target', () => {
    const w = new OtcWalk(BTC, 76_000, seeded(4000));
    w.setOverride(wire('76450.00', { jitter: false }), OPEN);
    const hold = run(w, CLOSE).filter((x) => x.t >= CLOSE - OTC_OVERRIDE_HOLD_MS);
    for (const x of hold) expect(x.p).toBe(76_450);
  });
});
