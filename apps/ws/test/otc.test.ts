import { describe, expect, it } from 'vitest';
import { cryptoNormal, OtcFeed, OtcWalk, type OtcHistoryRow } from '../src/feed/otc.js';

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
      for (let i = 0; i < 3600; i++) w.step(1);
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
      for (let i = 0; i < 60; i++) w.step(1);
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
      for (let i = 0; i < 60 * 86_400; i += 60) w.step(60);
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
      b.step(1);
      r.step(1);
    }
    expect(Math.log(b.price / r.price)).toBeCloseTo(2 * 0.00075 * 24, 6);

    // Always buying on Bull for 30 minutes must not beat the ~52.1% needed to profit at 92%.
    let up = 0;
    const n = 4000;
    for (let k = 0; k < n; k++) {
      const w = new OtcWalk(bull, 1000, seeded(k + 99));
      for (let i = 0; i < 1800; i++) w.step(1);
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
          for (let i = 0; i < T; i++) w.step(1);
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
      for (let i = 0; i < 1800; i++) w.step(1);
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
});
