import { describe, expect, it } from 'vitest';
import type { Candle } from '@traderoom/shared';
import btc from './__fixtures__/btcusdt-5m-2026-11-07.json';
import { ALL_FAMILIES, findPatterns, patternSettings, visiblePatterns, zigzag, type Pattern, type PatternOptions } from './patterns';

// The close sticks out a little further than the open, so each turn has one clear swing bar.
const bar = (i: number, o: number, c: number): Candle => ({ t: i * 60_000, o, h: Math.max(o + 0.05, c + 0.1), l: Math.min(o - 0.05, c - 0.1), c, v: 0 });
const fromCloses = (closes: number[]) => closes.map((c, i) => bar(i, i === 0 ? c : closes[i - 1]!, c));

/** Straight legs through turning points; each leg `per` bars, or [price, bars]. */
function path(points: Array<number | [number, number]>, per = 6): Candle[] {
  const pts = points.map((p) => (Array.isArray(p) ? p : ([p, per] as [number, number])));
  // A short lead-in the other way, so the first point is a swing point too.
  const [p0, p1] = [pts[0]![0], pts[1]![0]];
  pts.splice(1, 0, [p0, 0]);
  pts[0] = [p0 + (p1 - p0) * 0.3, 0];
  pts[1] = [p0, per];
  const closes = [pts[0]![0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]![0];
    const [b, n] = pts[i]!;
    for (let s = 1; s <= n; s++) closes.push(a + ((b - a) * s) / n);
  }
  return fromCloses(closes);
}

const opts = (o: Partial<PatternOptions> = {}): PatternOptions => ({
  depth: 3,
  minAtr: 1,
  inProgress: false,
  families: ALL_FAMILIES,
  ...o,
});
const types = (c: Candle[], o = opts()) => findPatterns(c, o).map((p) => p.type);

describe('swing points', () => {
  it('alternate highs and lows', () => {
    const z = zigzag(path([100, 120, 108, 120, 100, 104]), 3);
    expect(z.map((p) => p.kind).join('')).toBe('LHLHL');
    for (const p of z) expect(p.at).toBe(p.idx + 3);
  });
});

describe('tops and bottoms', () => {
  it('double top: two equal highs, then a close under the neckline', () => {
    const [p] = findPatterns(path([100, 120, 108, 120, 100, 104]), opts());
    expect(p).toMatchObject({ type: 'doubleTop', dir: -1, name: 'Topo duplo', status: 'awaiting' });
    expect(p!.target).toBeCloseTo(107.9 - 12.2);
    expect(p!.breakout.p).toBeLessThan(107.9);
  });

  it('double bottom', () => {
    expect(types(path([120, 100, 112, 100, 120, 116]))).toEqual(['doubleBottom']);
  });

  it('triple top wins over the double top inside it', () => {
    expect(types(path([100, 120, 108, 120, 108, 120, 100, 104]))).toContain('tripleTop');
  });

  it('head and shoulders, target measured from the neckline', () => {
    const [p] = findPatterns(path([95, 115, 105, 125, 105, 115, 80, 83]), opts());
    expect(p).toMatchObject({ type: 'headShoulders', dir: -1 });
    expect(p!.target).toBeCloseTo(104.9 - 20.2);
    expect(p!.status).toBe('reached');
  });

  it('inverse head and shoulders', () => {
    expect(types(path([125, 105, 115, 95, 115, 105, 125, 122]))).toContain('inverseHeadShoulders');
  });
});

describe('channels', () => {
  it('falling wedge breaks up', () => {
    const [p] = findPatterns(path([130, 100, 122, 97, 114, 94, 120, 118]), opts());
    expect(p).toMatchObject({ type: 'fallingWedge', dir: 1 });
    expect(p!.upper!.a.p).toBeGreaterThan(p!.lower!.a.p);
  });

  it('rising wedge breaks down', () => {
    expect(types(path([100, 130, 108, 133, 116, 136, 100, 103]))).toContain('risingWedge');
  });

  it('ascending triangle: flat top, rising lows', () => {
    const ps = findPatterns(path([120, 100, 120, 106, 120, 112, 130, 128]), opts());
    expect(ps.map((p) => p.type)).toEqual(['ascendingTriangle']);
    expect(ps[0]!.dir).toBe(1);
  });

  it('symmetrical triangle breaks either way', () => {
    expect(findPatterns(path([130, 100, 126, 104, 122, 108, 95, 98]), opts())[0]).toMatchObject({ type: 'symmetricalTriangle', dir: -1 });
  });

  it('rectangle (when triple tops are switched off)', () => {
    const c = path([120, 100, 120, 100, 120, 100, 90, 92]);
    expect(types(c, opts({ families: { ...ALL_FAMILIES, triple: false } }))).toContain('rectangle');
  });
});

describe('flags and cup', () => {
  it('bull flag: sharp pole, short channel against it, break up', () => {
    const c = path([
      [100, 0],
      [130, 4],
      [126, 3],
      [128.5, 3],
      [124.5, 3],
      [135, 5],
      [134, 2],
    ]);
    const [p] = findPatterns(c, opts({ depth: 2 }));
    expect(p).toMatchObject({ type: 'bullFlag', dir: 1 });
    expect(p!.target - p!.breakout.p).toBeCloseTo(30.2);
  });

  it('bear pennant: pole down, converging, break down', () => {
    const c = path([
      [130, 0],
      [100, 4],
      [106, 3],
      [101.5, 3],
      [104.5, 3],
      [95, 5],
      [96, 2],
    ]);
    expect(types(c, opts({ depth: 2 }))).toContain('bearPennant');
  });

  it('cup and handle', () => {
    const c = fromCloses([
      110, 115, 120, 118, 115, 111, 107, 104, 102, 101, 100.5, 100, 101, 100.5, 100, 101, 100.2, 100.8, 101.5, 103, 105, 108, 111, 114, 117,
      119.5, 120, 118, 116, 114.5, 116, 119, 121.5, 124, 123,
    ]);
    const [p] = findPatterns(c, opts({ depth: 2 }));
    expect(p).toMatchObject({ type: 'cupHandle', dir: 1 });
    expect(p!.cup!.bottom.p).toBeCloseTo(99.9);
  });
});

describe('lifecycle and view', () => {
  it('a pattern that falls back through its invalidation level fails', () => {
    const c = path([100, 120, 108, 120, 104, 125, 124]);
    expect(findPatterns(c, opts())[0]).toMatchObject({ type: 'doubleTop', status: 'failed' });
  });

  it('nothing repaints: a pattern already settled keeps its points and status with more history', () => {
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
    let p = 100;
    const c = Array.from({ length: 600 }, (_, i) => {
      const o = p;
      p += rnd() * 3;
      return bar(i, o, p);
    });
    // Which ones get drawn can change (TradingView too prefers the ones still awaiting), but a shape
    // that has already reached or failed is the same shape later on.
    const key = (x: { type: string; points: Array<{ i: number }>; breakout: { i: number }; status: string }) =>
      `${x.type}@${x.points.map((q) => q.i).join(',')}-${x.breakout.i}:${x.status}`;
    const every: Pattern[] = [];
    findPatterns(c, opts(), every);
    const full = new Set(every.map(key));
    let checked = 0;
    for (const n of [200, 350, 480])
      for (const x of findPatterns(c.slice(0, n), opts()))
        if (x.status === 'reached' || x.status === 'failed') {
          expect(full.has(key(x))).toBe(true);
          checked++;
        }
    expect(checked).toBeGreaterThan(3);
  });

  it('"last awaiting" shows only the newest pattern still heading to its target', () => {
    const c = path([100, 120, 108, 120, 100, 104]);
    const all = findPatterns(c, opts());
    expect(visiblePatterns(all, 'last')).toHaveLength(1);
    expect(visiblePatterns([{ ...all[0]!, status: 'reached' }], 'last')).toHaveLength(0);
    expect(visiblePatterns([{ ...all[0]!, status: 'reached' }], 'all')).toHaveLength(1);
    expect(patternSettings({ show: 0, wedge: 0 }).options.families.wedge).toBe(false);
    expect(patternSettings({}).show).toBe('last');
  });
});

describe('against TradingView (BTCUSDT 5m, Binance, 2026-11-07 ~13:20 UTC-3)', () => {
  // What "All chart patterns", Patterns = Last Awaiting, showed on the same candles.
  const candles: Candle[] = (btc as Array<[number, number, number, number, number]>).map(([t, o, h, l, c]) => ({ t, o, h, l, c, v: 0 }));
  const at = (i: number) => new Date(candles[i]!.t).toISOString().slice(5, 16);
  const shown = visiblePatterns(findPatterns(candles), 'last');
  const find = (type: string) => shown.find((p) => p.type === type);
  const touches = (type: string) => find(type)?.points.map((q) => at(q.i));

  it('shows the same four patterns, and nothing else', () => {
    expect(shown.map((p) => p.type).sort()).toEqual(['doubleTop', 'rectangle', 'risingWedge', 'symmetricalTriangle']);
  });

  it('draws them through the same swing points and breakouts', () => {
    // Times in UTC (TradingView showed them 3 hours earlier, in UTC-3).
    expect(touches('risingWedge')).toEqual(['11-06T17:50', '11-06T22:00', '11-07T03:40', '11-07T09:00']);
    expect(at(find('risingWedge')!.breakout.i)).toBe('11-07T10:25');
    // The triangle and rectangle end on the swing points TradingView drew and break on the same bar;
    // their first points still differ (TradingView started them at 19:45 and 20:50).
    expect(touches('symmetricalTriangle')!.slice(-2)).toEqual(['11-06T12:25', '11-06T14:30']);
    expect(touches('rectangle')!.slice(-3)).toEqual(['11-06T07:30', '11-06T12:25', '11-06T14:30']);
    expect(at(find('symmetricalTriangle')!.breakout.i)).toBe('11-06T15:00');
    expect(at(find('doubleTop')!.breakout.i)).toBe('11-07T15:45');
  });

  it('ignores a "triangle" that only breaks at its apex (the 74,888 spike)', () => {
    const all = findPatterns(candles);
    expect(all.some((p) => p.family === 'triangle' && at(p.start) === '11-06T12:25' && at(p.breakout.i) === '11-07T07:05')).toBe(false);
  });
});
