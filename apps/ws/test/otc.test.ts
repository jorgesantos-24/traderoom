import { describe, expect, it } from 'vitest';
import {
  OTC_OVERRIDE_HOLD_MS,
  OTC_OVERRIDE_RAMP_DEFAULT_MS,
  OTC_OVERRIDE_RELEASE_MS,
  otcOverrideRampStartMs,
  type OtcOverrideWire,
} from '@traderoom/shared';
import { cryptoNormal, OtcFeed, OtcWalk, type OtcHistoryRow } from '../src/feed/otc.js';
import { BAND_FRACTION } from '../src/feed/override-path.js';

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

const ADA = { startPrice: 0.18, volPctHour: 1.4, decimals: 4 };

describe('OtcWalk', () => {
  it('moves by about the configured hourly volatility', () => {
    const moves: number[] = [];
    for (let k = 0; k < 400; k++) {
      const w = new OtcWalk(ADA, 0.18, seeded(k + 1));
      for (let i = 0; i < 3600; i++) w.step(1, 0);
      moves.push(Math.log(w.price / 0.18));
    }
    const sd = Math.sqrt(moves.reduce((a, m) => a + m * m, 0) / moves.length);
    // 1.4%/h plus a little from trends; mean reversion is negligible over one hour.
    expect(sd).toBeGreaterThan(0.012);
    expect(sd).toBeLessThan(0.017);
  });

  it('has no built-in direction: ups and downs are balanced', () => {
    let up = 0;
    const n = 2000;
    for (let k = 0; k < n; k++) {
      const w = new OtcWalk(ADA, 0.18, seeded(k + 7));
      for (let i = 0; i < 60; i++) w.step(1, 0);
      if (w.price > 0.18) up++;
    }
    expect(up / n).toBeGreaterThan(0.45);
    expect(up / n).toBeLessThan(0.55);
  });

  it('drifts back toward its reference level over months', () => {
    // From 50% above the reference, two half-lives later it should be most of the way back.
    let above = 0;
    for (let k = 0; k < 20; k++) {
      const w = new OtcWalk({ ...ADA, volPctHour: 0.3 }, 0.27, seeded(k + 3));
      for (let i = 0; i < 60 * 86_400; i += 60) w.step(60, 0);
      above += Math.log(w.price / 0.18);
    }
    expect(above / 20).toBeLessThan(Math.log(1.5) * 0.4);
    expect(above / 20).toBeGreaterThan(0);
  });

  it('a trend (Bull/Bear) moves the long run but barely changes a 30-minute trade', () => {
    const bull = { startPrice: 1000, volPctHour: 1.5, decimals: 2, driftPctHour: 0.075 };
    const bear = { ...bull, driftPctHour: -0.075 };
    // Same random draws: the only difference between the two paths is the trend.
    const b = new OtcWalk(bull, 1000, seeded(5));
    const r = new OtcWalk(bear, 1000, seeded(5));
    for (let i = 0; i < 86_400; i++) {
      b.step(1, 0);
      r.step(1, 0);
    }
    expect(Math.log(b.price / r.price)).toBeCloseTo(2 * 0.00075 * 24, 6);

    // Always buying on Bull for 30 minutes must not beat the ~52.1% needed to profit at 92%.
    let up = 0;
    const n = 4000;
    for (let k = 0; k < n; k++) {
      const w = new OtcWalk(bull, 1000, seeded(k + 99));
      for (let i = 0; i < 1800; i++) w.step(1, 0);
      if (w.price > 1000) up++;
    }
    expect(up / n).toBeLessThan(0.535);
  });

  // At a 92% payout a strategy needs about 52.1% wins to profit. None of these may get close.
  const BREAK_EVEN = 1 / 1.92;

  it('following the last move does not pay (60 s and 5 min)', () => {
    for (const T of [60, 300]) {
      let hits = 0;
      let n = 0;
      for (let k = 0; k < 40; k++) {
        const w = new OtcWalk(ADA, 0.18, seeded(1000 + k));
        let prev = w.price;
        let lastMove = 0;
        for (let round = 0; round < 300; round++) {
          for (let i = 0; i < T; i++) w.step(1, 0);
          const move = w.price - prev;
          if (lastMove !== 0 && move !== 0) {
            n++;
            if (Math.sign(move) === Math.sign(lastMove)) hits++;
          }
          lastMove = move;
          prev = w.price;
        }
      }
      expect(hits / n).toBeLessThan(BREAK_EVEN - 0.005);
    }
  });

  it('betting on the return to the reference level does not pay (30 min, far from it)', () => {
    let hits = 0;
    const n = 3000;
    for (let k = 0; k < n; k++) {
      // Start 10% above the reference: the bet is "it goes down".
      const w = new OtcWalk(ADA, 0.18 * 1.1, seeded(5000 + k));
      const start = w.price;
      for (let i = 0; i < 1800; i++) w.step(1, 0);
      if (w.price < start) hits++;
    }
    expect(hits / n).toBeLessThan(BREAK_EVEN - 0.005);
  });

  it('formats with the asset decimals', () => {
    const w = new OtcWalk(ADA, 0.18, seeded());
    expect(w.format(0.123456)).toBe('0.1235');
  });

  it('crypto normals look standard normal', () => {
    const n = cryptoNormal();
    const xs = Array.from({ length: 20_000 }, n);
    const mean = xs.reduce((a, x) => a + x, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length);
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(sd).toBeGreaterThan(0.95);
    expect(sd).toBeLessThan(1.05);
  });
});

describe('OtcFeed', () => {
  it('writes history for a new asset and then ticks from where it ended', async () => {
    const rows: OtcHistoryRow[] = [];
    const feed = new OtcFeed({
      lastPrice: async () => null,
      writeHistory: async (r) => void rows.push(...r),
      normal: seeded(5),
      onError: (err) => {
        throw err;
      },
    });
    const now = 1_800_000_000_000;
    await feed.sync([{ id: 9, symbol: 'ADAOTC', otc: ADA }], now);
    expect(rows).toHaveLength(48 * 3600);
    expect(rows.at(-1)!.capturedAt.getTime()).toBeLessThan(now);
    const [t] = feed.tick(now + 500);
    expect(t).toMatchObject({ symbol: 'ADAOTC', provider: 'otc', ts: now + 500 });
    expect(Math.abs(t!.value / Number(rows.at(-1)!.price) - 1)).toBeLessThan(0.01);
  });

  it('continues from the stored price after a restart, without new history', async () => {
    let wrote = 0;
    const feed = new OtcFeed({
      lastPrice: async () => 0.2,
      writeHistory: async (r) => void (wrote += r.length),
      normal: seeded(6),
      onError: () => {},
    });
    await feed.sync([{ id: 9, symbol: 'ADAOTC', otc: ADA }], 1000);
    expect(wrote).toBe(0);
    expect(Math.abs(feed.tick(1500)[0]!.value - 0.2)).toBeLessThan(0.001);
    await feed.sync([], 2000);
    expect(feed.tick(2500)).toEqual([]);
  });

  it('starts new assets one at a time and retries one that failed on the next sync', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let failFirst = true;
    const errors: string[] = [];
    let clock = 1_800_000_000_000;
    const feed = new OtcFeed({
      lastPrice: async (id) => {
        if (id === 2 && failFirst) {
          failFirst = false;
          throw new Error('timeout exceeded when trying to connect');
        }
        return null;
      },
      writeHistory: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 0));
        inFlight--;
      },
      normal: seeded(7),
      now: () => (clock += 60_000), // each later start sees the time moved on
      onError: (_err, symbol) => void errors.push(symbol),
    });
    const assets = [1, 2, 3].map((id) => ({ id, symbol: `A${id}OTC`, otc: ADA }));
    await feed.sync(assets, clock);
    expect(maxInFlight).toBe(1);
    expect(errors).toEqual(['A2OTC']);
    expect(
      feed
        .tick(clock + 500)
        .map((t) => t.symbol)
        .sort(),
    ).toEqual(['A1OTC', 'A3OTC']);
    await feed.sync(assets, clock + 1000);
    expect(
      feed
        .tick(clock + 1500)
        .map((t) => t.symbol)
        .sort(),
    ).toEqual(['A1OTC', 'A2OTC', 'A3OTC']);
  });
});

describe('OtcWalk override', () => {
  const BTC = { startPrice: 76_000, volPctHour: 0.8, decimals: 2 };
  const CLOSE = 1_800_000_060_000;
  const TICK_MS = 500;
  /** Starts well before the ramp so the walk has a natural past. */
  const START = CLOSE - 60_000;

  function wire(target: string, over: Partial<OtcOverrideWire> = {}): OtcOverrideWire {
    return {
      symbol: 'BTCOTC',
      targetPrice: target,
      basePrice: '76000.00',
      closeMs: CLOSE,
      rampStartMs: otcOverrideRampStartMs(START, CLOSE),
      holdMs: OTC_OVERRIDE_HOLD_MS,
      releaseMs: OTC_OVERRIDE_RELEASE_MS,
      ...over,
    };
  }

  /** Steps from START to `until` every TICK_MS (shifted by `offset`), plus one step at `extra` times. */
  function run(w: OtcWalk, until: number, offset = 0, extra: number[] = []) {
    const times = new Set<number>(extra);
    for (let t = START + offset; t <= until; t += TICK_MS) times.add(t);
    const out: Array<{ t: number; p: string }> = [];
    let last = START;
    for (const t of [...times].sort((a, b) => a - b)) {
      out.push({ t, p: w.format(w.step((t - last) / 1000, t)) });
      last = t;
    }
    return out;
  }

  /**
   * With jitter the hold wobbles around the target within BAND_FRACTION of the body (target − ramp start).
   * `drift` covers how far the ramp start may be from `from` when the test cannot see it.
   */
  const nearTarget = (p: string | number, target: string, from: number, drift = 0) =>
    Math.abs(Number(p) - Number(target)) <= BAND_FRACTION * (Math.abs(Number(target) - from) + drift) + 0.01 + 1e-9;

  it('jitter off: lands exactly on the target at closeMs and holds it for at least 3 ticks, up and down, any tick phase', () => {
    for (const [seed, target] of [
      [1, '76450.00'],
      [2, '75600.00'],
      [3, '76000.01'],
    ] as const) {
      for (const offset of [0, 137, 250, 499]) {
        const w = new OtcWalk(BTC, 76_000, seeded(seed));
        w.setOverride(wire(target, { jitter: false }), START);
        const ticks = run(w, CLOSE + OTC_OVERRIDE_RELEASE_MS + 1000, offset, [CLOSE]);
        const atClose = ticks.find((x) => x.t === CLOSE);
        expect(atClose?.p).toBe(target);
        const inHold = ticks.filter((x) => x.t >= CLOSE - OTC_OVERRIDE_HOLD_MS && x.t <= CLOSE);
        expect(inHold.length).toBeGreaterThanOrEqual(3);
        for (const x of inHold) expect(x.p).toBe(target);
        // The ramp only moves toward the target: no overshoot past it.
        const ramp = ticks.filter(
          (x) => x.t >= CLOSE - OTC_OVERRIDE_HOLD_MS - OTC_OVERRIDE_RAMP_DEFAULT_MS && x.t < CLOSE - OTC_OVERRIDE_HOLD_MS,
        );
        const up = Number(target) > Number(ramp[0]!.p);
        for (let i = 1; i < ramp.length; i++) {
          const d = Number(ramp[i]!.p) - Number(ramp[i - 1]!.p);
          expect(up ? d >= 0 : d <= 0).toBe(true);
        }
      }
    }
  });

  it('jitter off: a snapshot anywhere in the hold sees the target even when the newest tick is 700 ms old', () => {
    for (const offset of [0, 1, 137, 250, 499]) {
      const w = new OtcWalk(BTC, 76_000, seeded(21 + offset));
      w.setOverride(wire('76321.09', { jitter: false }), START);
      const ticks = run(w, CLOSE, offset, [CLOSE]);
      for (let at = CLOSE - OTC_OVERRIDE_HOLD_MS; at <= CLOSE; at += 50) {
        // Newest tick published by `at`: one OTC tick plus one 200 ms conflation window late.
        const seen = ticks.filter((x) => x.t <= at - 200).at(-1);
        expect(seen?.p, `offset ${offset}, at close-${CLOSE - at}`).toBe('76321.09');
      }
    }
  });

  it('jitter off: after close+release the price is back on the natural path (< 0.1%)', () => {
    // Fixed normals: the natural path is deterministic, so a walk without override is the reference.
    const zero = () => 0;
    for (const target of ['77500.00', '74500.00']) {
      const ov = new OtcWalk(BTC, 76_000, zero);
      const ref = new OtcWalk(BTC, 76_000, zero);
      ov.setOverride(wire(target, { jitter: false }), START);
      const end = CLOSE + OTC_OVERRIDE_RELEASE_MS + 5000;
      const a = run(ov, end);
      const b = run(ref, end);
      expect(a.find((x) => x.t === CLOSE)?.p).toBe(target);
      expect(ov.overrideActive).toBe(false);
      const after = a.findIndex((x) => x.t >= CLOSE + OTC_OVERRIDE_RELEASE_MS);
      for (let i = after; i < a.length; i++) {
        expect(Math.abs(Number(a[i]!.p) / Number(b[i]!.p) - 1)).toBeLessThan(0.001);
      }
    }
  });

  it('with random normals the return lands within the noise of ramp+hold+release, not of the whole candle', () => {
    let worst = 0;
    for (let k = 0; k < 200; k++) {
      const w = new OtcWalk(BTC, 76_000, seeded(300 + k));
      w.setOverride(wire('76800.00'), START);
      const ticks = run(w, CLOSE + OTC_OVERRIDE_RELEASE_MS);
      // Last natural tick before the ramp takes over.
      const rampStart = ticks.filter((x) => x.t < otcOverrideRampStartMs(START, CLOSE)).at(-1)!;
      const back = ticks.at(-1)!;
      worst = Math.max(worst, Math.abs(Number(back.p) / Number(rampStart.p) - 1));
    }
    // 0.8%/h over ~13 s is ~0.05% per sd; 200 paths stay well under 0.3%.
    expect(worst).toBeLessThan(0.003);
  });

  it('the return ignores basePrice: the shadow is born from the visible price at the ramp start', () => {
    const zero = () => 0;
    // basePrice is informational only; an absurd one must not pull the release anywhere.
    const ov = new OtcWalk(BTC, 76_000, zero);
    const ref = new OtcWalk(BTC, 76_000, zero);
    ov.setOverride(wire('77000.00', { basePrice: '1.00' }), START);
    const end = CLOSE + OTC_OVERRIDE_RELEASE_MS + 1000;
    const a = run(ov, end);
    const b = run(ref, end);
    expect(Math.abs(Number(a.at(-1)!.p) / Number(b.at(-1)!.p) - 1)).toBeLessThan(0.001);
  });

  it('applied ~50 s early, the return is measured from the ramp start, not from when it was applied', () => {
    // Noisy natural path before the ramp; the release must land near where the ramp began.
    let worst = 0;
    for (let k = 0; k < 200; k++) {
      const w = new OtcWalk({ ...BTC, volPctHour: 3 }, 76_000, seeded(700 + k));
      w.setOverride(wire('76900.00'), START);
      const ticks = run(w, CLOSE + OTC_OVERRIDE_RELEASE_MS);
      const rampStart = otcOverrideRampStartMs(START, CLOSE);
      const atRamp = ticks.filter((x) => x.t < rampStart).at(-1)!;
      worst = Math.max(worst, Math.abs(Number(ticks.at(-1)!.p) / Number(atRamp.p) - 1));
    }
    // 3%/h over the ~14 s from ramp start to release end is ~0.19% per sd; 50 s more of it would show.
    expect(worst).toBeLessThan(0.0085);
  });

  it('re-sending the identical payload every tick changes nothing (no re-seeded shadow, no restarted ramp)', () => {
    const once = new OtcWalk(BTC, 76_000, seeded(31));
    const every = new OtcWalk(BTC, 76_000, seeded(31));
    const o = wire('76400.00');
    once.setOverride(o, START);
    every.setOverride(o, START);
    let last = START;
    for (let t = START + TICK_MS; t <= CLOSE + OTC_OVERRIDE_RELEASE_MS + 2000; t += TICK_MS) {
      every.setOverride({ ...o }, t);
      expect(every.format(every.step((t - last) / 1000, t))).toBe(once.format(once.step((t - last) / 1000, t)));
      last = t;
    }
  });

  it('jitter off: re-targeting mid-ramp resets x0 and the shadow to the current price', () => {
    const zero = () => 0;
    const w = new OtcWalk(BTC, 76_000, zero);
    w.setOverride(wire('77000.00', { jitter: false }), START);
    const mid = CLOSE - OTC_OVERRIDE_HOLD_MS - 5000;
    const before = run(w, mid);
    const atRetarget = Number(before.at(-1)!.p);
    expect(atRetarget).toBeGreaterThan(76_300); // well into the first ramp
    w.setOverride(wire('76500.00', { jitter: false }), mid);
    const step1 = w.step(TICK_MS / 1000, mid + TICK_MS);
    expect(step1).toBeLessThan(atRetarget); // heads to the new target, from here
    let t = mid + TICK_MS;
    let last = t;
    let price = step1;
    while (t < CLOSE + OTC_OVERRIDE_RELEASE_MS) {
      t += TICK_MS;
      price = w.step((t - last) / 1000, t);
      last = t;
      if (t === CLOSE) expect(w.format(price)).toBe('76500.00');
    }
    // The new shadow started at the re-target price, so that is where the release lands.
    expect(Math.abs(price / atRetarget - 1)).toBeLessThan(0.001);
  });

  it('releasing mid-ramp continues naturally from where the price is, without jumps or NaN', () => {
    const w = new OtcWalk(BTC, 76_000, seeded(9));
    w.setOverride(wire('77000.00'), START);
    const mid = CLOSE - OTC_OVERRIDE_HOLD_MS - OTC_OVERRIDE_RAMP_DEFAULT_MS / 2;
    const before = run(w, mid);
    const lastRamp = Number(before.at(-1)!.p);
    w.setOverride(null, mid);
    expect(w.overrideActive).toBe(false);
    let prev = lastRamp;
    let last = mid;
    for (let t = mid + TICK_MS; t <= CLOSE + 10_000; t += TICK_MS) {
      const p = w.step((t - last) / 1000, t);
      last = t;
      expect(Number.isFinite(p)).toBe(true);
      // One 0.5 s natural step at 0.8%/h is ~0.01%; 0.1% would be a jump.
      expect(Math.abs(p / prev - 1)).toBeLessThan(0.001);
      prev = p;
    }
    // Never forced: nothing pins the old target at the old close.
    expect(w.format()).not.toBe('77000.00');
  });

  it('re-sending the same payload is idempotent; a new target mid-ramp ramps from the current price', () => {
    const w = new OtcWalk(BTC, 76_000, seeded(11));
    const o = wire('76500.00');
    w.setOverride(o, START);
    const mid = CLOSE - OTC_OVERRIDE_HOLD_MS - 4000;
    const a = run(w, mid);
    w.setOverride(o, mid);
    const p0 = Number(a.at(-1)!.p);
    const next = w.step(TICK_MS / 1000, mid + TICK_MS);
    expect(Math.abs(next / p0 - 1)).toBeLessThan(0.002);
    w.setOverride(wire('75500.00'), mid + TICK_MS);
    const jump = w.step(TICK_MS / 1000, mid + 2 * TICK_MS);
    // A fresh ramp from the current price: the first step is bridge progress, not a leap to the target
    // (ramping on the old clock covered ~90% of the way in one tick).
    expect(jump).toBeLessThan(next);
    expect(Math.abs(jump - next)).toBeLessThan(0.55 * Math.abs(75_500 - next));
    let t = mid + 2 * TICK_MS;
    while (t < CLOSE) {
      t += TICK_MS;
      w.step(TICK_MS / 1000, t);
    }
    expect(nearTarget(w.step(0.001, CLOSE), '75500.00', next)).toBe(true);
  });

  it('OtcFeed applies the override only to its symbol', async () => {
    const feed = new OtcFeed({ lastPrice: async () => 76_000, writeHistory: async () => {}, normal: seeded(4), onError: () => {} });
    await feed.sync(
      [
        { id: 1, symbol: 'BTCOTC', otc: BTC },
        { id: 2, symbol: 'ETHOTC', otc: { startPrice: 3000, volPctHour: 1, decimals: 2 } },
      ],
      START,
    );
    feed.setOverride(wire('76600.00'), START);
    let last: ReturnType<OtcFeed['tick']> = [];
    for (let t = START + TICK_MS; t <= CLOSE; t += TICK_MS) last = feed.tick(t);
    expect(nearTarget(last.find((x) => x.symbol === 'BTCOTC')!.price, '76600.00', 76_000, 300)).toBe(true);
    expect(last.find((x) => x.symbol === 'ETHOTC')?.price).not.toBe('76600.00');
  });

  it('OtcFeed marks ticks with ov and the natural price only while the override changes the price', async () => {
    const feed = new OtcFeed({ lastPrice: async () => 76_000, writeHistory: async () => {}, normal: seeded(5), onError: () => {} });
    await feed.sync([{ id: 1, symbol: 'BTCOTC', otc: BTC }], START);
    const w = wire('76600.00', { id: '9' });
    const releaseEnd = CLOSE + OTC_OVERRIDE_RELEASE_MS;
    feed.setOverride(w, START);
    let marked = 0;
    for (let t = START + TICK_MS; t <= releaseEnd + 3000; t += TICK_MS) {
      const tick = feed.tick(t).find((x) => x.symbol === 'BTCOTC');
      if (!tick) throw new Error('no tick');
      if (t < w.rampStartMs || t >= releaseEnd) {
        expect(tick.ov).toBeUndefined();
        expect(tick.realPrice).toBeUndefined();
        continue;
      }
      marked++;
      expect(tick.ov).toBe('9');
      expect(tick.realPrice).toMatch(/^\d+\.\d{2}$/);
      // In the hold the shown price is near the target; the natural path is elsewhere.
      if (t >= CLOSE - OTC_OVERRIDE_HOLD_MS && t <= CLOSE) {
        expect(nearTarget(tick.price, '76600.00', 76_000, 300)).toBe(true);
        expect(tick.realPrice).not.toBe('76600.00');
      }
    }
    expect(marked).toBeGreaterThan(10);

    // A wire without an id (written before ids existed) changes the price but cannot mark it.
    const legacy = new OtcWalk(BTC, 76_000, seeded(6));
    legacy.setOverride(wire('76600.00'), START);
    legacy.step(TICK_MS / 1000, w.rampStartMs);
    expect(legacy.overrideId).toBeNull();
    expect(legacy.naturalPrice).not.toBe(legacy.price);
  });
});
