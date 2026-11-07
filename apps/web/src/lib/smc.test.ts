import { describe, expect, it } from 'vitest';
import type { Candle } from '@traderoom/shared';
import { computeSmc, DEFAULT_SMC, legTurn, previousLevels, smcSettings, visibleSmc, type SmcOptions } from './smc';

const MIN = 60_000;
const bar = (i: number, o: number, c: number, h = Math.max(o, c) + 0.1, l = Math.min(o, c) - 0.1): Candle => ({
  t: i * MIN,
  o,
  h,
  l,
  c,
  v: 0,
});

/** Straight legs through the given turning points, `per` bars each. */
function path(points: number[], per = 6): Candle[] {
  const closes = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    for (let s = 1; s <= per; s++) closes.push(a + ((b - a) * s) / per);
  }
  return closes.map((c, i) => bar(i, i === 0 ? c : closes[i - 1]!, c));
}

const opts = (o: Partial<SmcOptions> = {}): SmcOptions => ({
  ...DEFAULT_SMC,
  internalLen: 2,
  swingLen: 3,
  fvgAuto: false,
  obMitigation: 'close',
  ...o,
});

describe('pivots (alternating zigzag)', () => {
  it('highs and lows always alternate', () => {
    let seed = 3;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
    let p = 100;
    const c = Array.from({ length: 300 }, (_, i) => {
      const o = p;
      p += rnd() * 3;
      return bar(i, o, p);
    });
    const turns: string[] = [];
    let leg: 1 | -1 | 0 = 0;
    for (let k = 0; k < c.length; k++) {
      const t = legTurn(c, k, 5, leg);
      if (t) {
        turns.push(t);
        leg = t === 'high' ? -1 : 1;
      }
    }
    expect(turns.length).toBeGreaterThan(10);
    for (let i = 1; i < turns.length; i++) expect(turns[i]).not.toBe(turns[i - 1]);
  });
});

describe('market structure', () => {
  it('an uptrend breaks highs (BOS) and prints HH / HL', () => {
    const r = computeSmc(path([100, 110, 105, 115, 110, 120, 115, 125]), opts());
    const swing = r.structure.filter((s) => s.level === 'swing');
    expect(swing.every((s) => s.dir === 1 && s.kind === 'BOS')).toBe(true);
    expect(swing.map((s) => Math.round(s.price))).toEqual([110, 115, 120]);
    expect(r.swings.map((s) => s.label)).toEqual(expect.arrayContaining(['HH', 'HL']));
    expect(r.trend.swing).toBe(1);
  });

  it('losing the last higher low is a bearish CHoCH, with a bearish order block at the top', () => {
    const c = path([100, 110, 105, 115, 108, 120, 100]);
    const r = computeSmc(c, opts());
    const last = r.structure.filter((s) => s.level === 'swing').at(-1)!;
    expect(last).toMatchObject({ kind: 'CHoCH', dir: -1 });
    expect(last.price).toBeCloseTo(107.9);
    expect(r.trend.swing).toBe(-1);
    const ob = r.orderBlocks.find((o) => o.dir === -1 && o.at === last.to)!;
    expect(ob.top).toBeCloseTo(120.1);
    expect(ob.bottom).toBeLessThan(ob.top);
    // The block is the candle that made the top.
    expect(c[ob.from]!.h).toBeCloseTo(120.1);
  });

  it('a break is stamped on the closing bar, after the swing it breaks', () => {
    const r = computeSmc(path([100, 110, 105, 115]), opts());
    expect(r.structure.length).toBeGreaterThan(0);
    for (const s of r.structure) expect(s.to).toBeGreaterThan(s.from);
  });

  it('nothing repaints: a longer history only adds to what a shorter one found', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
    const c: Candle[] = [];
    let p = 100;
    for (let i = 0; i < 400; i++) {
      const o = p;
      p += rnd() * 2;
      c.push(bar(i, o, p, Math.max(o, p) + Math.abs(rnd()), Math.min(o, p) - Math.abs(rnd())));
    }
    const o = { ...DEFAULT_SMC, swingLen: 10, fvgAuto: true };
    const full = computeSmc(c, o);
    const key = (x: unknown) => JSON.stringify(x);
    const fullStructure = new Set(full.structure.map(key));
    const fullObs = new Set(full.orderBlocks.map((z) => key([z.from, z.dir, z.at, z.top, z.bottom])));
    const fullGaps = new Set(full.fvgs.map((g) => key([g.from, g.gapTop, g.gapBottom])));
    for (const n of [120, 230, 333]) {
      const part = computeSmc(c.slice(0, n), o);
      for (const s of part.structure) expect(fullStructure.has(key(s))).toBe(true);
      for (const z of part.orderBlocks) expect(fullObs.has(key([z.from, z.dir, z.at, z.top, z.bottom]))).toBe(true);
      for (const g of part.fvgs) expect(fullGaps.has(key([g.from, g.gapTop, g.gapBottom]))).toBe(true);
    }
    expect(full.structure.length).toBeGreaterThan(5);
    expect(full.orderBlocks.length).toBeGreaterThan(2);
  });
});

describe('order blocks', () => {
  it('invalidated by a close through it, or by any wick in wick mode', () => {
    const c = path([100, 110, 104, 116], 6);
    const ob = computeSmc(c, opts()).orderBlocks.find((o) => o.dir === 1 && o.level === 'swing')!;
    expect(ob.end).toBeNull();
    const n = c.length;
    const find = (cs: Candle[], o: SmcOptions) => computeSmc(cs, o).orderBlocks.find((x) => x.from === ob.from && x.dir === 1)!;
    // A wick below the block that closes back inside it.
    const wick = [...c, bar(n, 116, ob.top + 0.5, 116.2, ob.bottom - 1)];
    expect(find(wick, opts()).end).toBeNull();
    expect(find(wick, opts({ obMitigation: 'wick' })).end).toBe(n);
    const close = [...c, bar(n, 116, ob.bottom - 1)];
    expect(find(close, opts()).end).toBe(n);
  });
});

describe('fair value gaps', () => {
  const base = () => [bar(0, 100, 100), bar(1, 100, 100), bar(2, 100, 101), bar(3, 101, 110), bar(4, 110, 109, 111, 105)];

  it('finds a bullish gap and shrinks it as price fills it, until fully filled', () => {
    const c = base();
    const g = computeSmc(c, opts()).fvgs.find((x) => x.dir === 1 && x.from === 3)!;
    expect(g).toMatchObject({ from: 3, bottom: 101.1, top: 105 });
    const partial = computeSmc([...c, bar(5, 109, 106, 109.1, 103)], opts()).fvgs.find((x) => x.from === 3)!;
    expect(partial).toMatchObject({ top: 103, end: null, gapTop: 105 });
    const filled = computeSmc([...c, bar(5, 109, 106, 109.1, 100)], opts()).fvgs.find((x) => x.from === 3)!;
    expect(filled.end).toBe(5);
  });

  it('the auto filter drops gaps left by an ordinary candle', () => {
    const quiet = Array.from({ length: 30 }, (_, i) => bar(i, 100 + (i % 2) * 2, 100 + ((i + 1) % 2) * 2));
    const n = quiet.length;
    // A small step up leaving a tiny gap: bar n-1 high 102.1, bar n+1 low 102.2.
    const small = [...quiet, bar(n, 100, 102.15, 102.15, 100), bar(n + 1, 102.3, 102.4, 102.5, 102.2)];
    expect(computeSmc(small, opts({ fvgAuto: false })).fvgs.some((g) => g.from === n)).toBe(true);
    expect(computeSmc(small, opts({ fvgAuto: true })).fvgs.some((g) => g.from === n)).toBe(false);
  });
});

describe('liquidity and levels', () => {
  it('two matching highs are EQH, swept once a wick trades above', () => {
    const c = path([100, 110, 100, 110, 100], 5);
    const eq = computeSmc(c, opts({ eqLen: 3 })).equal.find((e) => e.kind === 'EQH')!;
    expect(eq.a.price).toBeCloseTo(110.1);
    expect(eq.swept).toBeNull();
    const n = c.length;
    const swept = computeSmc([...c, bar(n, 100, 105, 111, 99)], opts({ eqLen: 3 })).equal.find((e) => e.kind === 'EQH')!;
    expect(swept.swept).toBe(n);
  });

  it('previous day and previous week (Monday to Sunday, UTC)', () => {
    const DAY = 86_400_000;
    const now = Date.UTC(2026, 10, 5, 15); // Thursday
    const daily: Candle[] = Array.from({ length: 14 }, (_, i) => {
      const t = Date.UTC(2026, 10, 5) - (13 - i) * DAY;
      return { t, o: 1, c: 1, h: 100 + i, l: 50 - i, v: 0 };
    });
    const lv = previousLevels(daily, now);
    expect(lv.day).toEqual({ high: 112, low: 38, start: Date.UTC(2026, 10, 4) });
    // Last week: Mon 26 Oct .. Sun 1 Nov.
    const week = daily.filter((d) => d.t >= Date.UTC(2026, 9, 26) && d.t < Date.UTC(2026, 10, 2));
    expect(week).toHaveLength(7);
    expect(lv.week).toEqual({
      high: Math.max(...week.map((d) => d.h)),
      low: Math.min(...week.map((d) => d.l)),
      start: Date.UTC(2026, 9, 26),
    });
  });
});

describe('view', () => {
  it('present mode keeps only the latest break per level; params map to options', () => {
    const r = computeSmc(path([100, 110, 105, 115, 110, 120, 115, 125]), opts());
    const v = visibleSmc(r, smcSettings({ mode: 1, internalObs: 1, swingObs: 1 }).view);
    expect(v.structure.filter((x) => x.level === 'swing')).toHaveLength(1);
    expect(v.orderBlocks.length).toBeLessThanOrEqual(2);
    expect(smcSettings({ obMitigation: 1 }).options.obMitigation).toBe('wick');
    expect(smcSettings({}).prevDay).toBe(false);
  });
});
