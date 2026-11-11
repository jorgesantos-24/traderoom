import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Candle } from '@traderoom/shared';
import {
  atr,
  awesome,
  bollinger,
  cci,
  ema,
  fractals,
  highest,
  ichimoku,
  INDICATOR_BY_TYPE,
  INDICATORS,
  indicatorLabel,
  loadIndicators,
  lowest,
  macd,
  momentum,
  newIndicator,
  outputOffset,
  parabolicSar,
  rma,
  rsi,
  sma,
  stochastic,
  stochRsi,
  supertrend,
  williamsR,
  wma,
} from './indicators';

const close = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const k = (c: number, h = c + 1, l = c - 1, t = 0): Candle => ({ t, o: c, h, l, c, v: 0 });
const round = (v: Array<number | null>, d = 6) => v.map((x) => (x == null ? null : Number(x.toFixed(d))));

describe('moving averages (Pine ta.*)', () => {
  it('sma', () => {
    expect(sma(close, 3)).toEqual([null, null, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('ema is seeded with the sma of its first values', () => {
    const e = ema(close, 3);
    expect(e.slice(0, 3)).toEqual([null, null, 2]);
    // alpha = 0.5: 0.5*4 + 0.5*2 = 3
    expect(e[3]).toBe(3);
  });

  it('rma uses alpha 1/len', () => {
    const r = rma(close, 3);
    expect(r[2]).toBe(2);
    expect(r[3]).toBeCloseTo((1 / 3) * 4 + (2 / 3) * 2);
  });

  it('wma weights recent values more', () => {
    // (1*1 + 2*2 + 3*3) / 6
    expect(wma(close, 3)[2]).toBeCloseTo(14 / 6);
  });

  it('highest / lowest over a window', () => {
    expect(highest([3, 1, 4, 1, 5], 3)).toEqual([null, null, 4, 4, 5]);
    expect(lowest([3, 1, 4, 1, 5], 3)).toEqual([null, null, 1, 1, 1]);
  });
});

describe('oscillators', () => {
  it('rsi is 100 when price only rises and 0 when it only falls', () => {
    expect(rsi(close, 3).at(-1)).toBe(100);
    expect(rsi([...close].reverse(), 3).at(-1)).toBe(0);
    expect(rsi(close, 3).slice(0, 3)).toEqual([null, null, null]);
  });

  it('macd = fast ema − slow ema, histogram = macd − signal', () => {
    const src = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 5);
    const m = macd(src, 12, 26, 9);
    const fast = ema(src, 12);
    const slow = ema(src, 26);
    const i = 50;
    expect(m.macd[i]).toBeCloseTo(fast[i]! - slow[i]!);
    expect(m.hist[i]).toBeCloseTo(m.macd[i]! - m.signal[i]!);
    expect(m.signal[32]).toBeNull();
    expect(m.signal[33]).not.toBeNull();
  });

  it('stochastic and Williams %R span 0..100 and −100..0', () => {
    const cs = close.map((c) => k(c));
    const st = stochastic(cs, 3, 1, 1);
    expect(st.k.at(-1)).toBeCloseTo((100 * (10 - 7)) / (11 - 7));
    expect(williamsR(cs, 3).at(-1)).toBeCloseTo((100 * (10 - 11)) / (11 - 7));
  });

  it('cci is 0 on a flat series and positive above its mean', () => {
    expect(cci([5, 5, 5, 5], 3).at(-1)).toBe(0);
    expect(cci([1, 2, 3, 10], 3).at(-1)!).toBeGreaterThan(0);
  });

  it('momentum is the change over n bars', () => {
    expect(momentum(close, 3)).toEqual([null, null, null, 3, 3, 3, 3, 3, 3, 3]);
  });
});

describe('volatility', () => {
  it('bollinger bands sit mult population stdevs around the sma', () => {
    const b = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
    // population stdev of that classic sample is exactly 2
    expect(b.basis.at(-1)).toBe(5);
    expect(b.upper.at(-1)).toBe(9);
    expect(b.lower.at(-1)).toBe(1);
  });

  it('atr smooths the true range (gaps count)', () => {
    const cs = [k(10, 11, 9), k(20, 21, 19), k(20, 21, 19)];
    // TR: 2, |21-10| = 11, 2
    expect(round(atr(cs, 2))).toEqual([null, 6.5, 4.25]);
  });

  it('parabolic sar stays below a rising market and flips above after a drop', () => {
    const up = Array.from({ length: 10 }, (_, i) => k(100 + i * 2));
    const sarUp = parabolicSar(up, 0.02, 0.02, 0.2);
    expect(sarUp[0]).toBeNull();
    sarUp.slice(1).forEach((s, i) => expect(s!).toBeLessThan(up[i + 1]!.l));
    const down = [...up, k(80), k(75)];
    const sarDown = parabolicSar(down, 0.02, 0.02, 0.2);
    expect(sarDown.at(-1)!).toBeGreaterThan(down.at(-1)!.h);
  });
});

describe('new trend indicators', () => {
  it('supertrend: one trend per bar, support under a rising market, resistance over it after a crash', () => {
    const up = Array.from({ length: 30 }, (_, i) => k(100 + i));
    const st = supertrend(up, 10, 3);
    // Nothing until the ATR exists, then exactly one of the two lines per bar.
    expect(st.up.slice(0, 9).every((v) => v == null) && st.down.slice(0, 9).every((v) => v == null)).toBe(true);
    for (let i = 9; i < up.length; i++) expect((st.up[i] == null) !== (st.down[i] == null)).toBe(true);
    expect(st.up.at(-1)!).toBeLessThan(up.at(-1)!.l);
    const crash = [...up, ...Array.from({ length: 8 }, (_, i) => k(120 - i * 6))];
    const st2 = supertrend(crash, 10, 3);
    expect(st2.up.at(-1)).toBeNull();
    expect(st2.down.at(-1)!).toBeGreaterThan(crash.at(-1)!.h);
  });

  it('supertrend support never drops while the uptrend lasts', () => {
    const cs = Array.from({ length: 40 }, (_, i) => k(100 + i + (i % 3 === 0 ? -1.5 : 0)));
    const up = supertrend(cs, 5, 2).up;
    for (let i = 1; i < up.length; i++) if (up[i] != null && up[i - 1] != null) expect(up[i]!).toBeGreaterThanOrEqual(up[i - 1]!);
  });

  it('ichimoku lines are mid-ranges; spans drawn ahead and the lagging line behind', () => {
    const cs = Array.from({ length: 60 }, (_, i) => k(100 + i, 101 + i, 99 + i));
    const r = ichimoku(cs, 9, 26, 52);
    // Bar 8: highest high 109, lowest low 99.
    expect(r.conversion[8]).toBe(104);
    expect(r.conversion[7]).toBeNull();
    expect(r.base[25]).toBe((126 + 99) / 2);
    expect(r.leadA[25]).toBe((r.conversion[25]! + r.base[25]!) / 2);
    expect(r.leadB[51]).toBe((152 + 99) / 2);
    expect(r.lagging[59]).toBe(159);
    const def = INDICATOR_BY_TYPE.get('ichimoku')!;
    const p = newIndicator('ichimoku')!.params;
    expect([outputOffset(def, 'leadA', p), outputOffset(def, 'leadB', p), outputOffset(def, 'lagging', p), outputOffset(def, 'base', p)]).toEqual([
      25, 25, -25, 0,
    ]);
  });

  it('fractals mark a high above n bars on each side (ties do not count) and the mirror for lows', () => {
    const hl = (h: number, l: number) => k((h + l) / 2, h, l);
    const cs = [hl(2, 1), hl(3, 1.5), hl(6, 2), hl(3, 0.5), hl(2, 1.2), hl(6, 2), hl(6, 2), hl(3, 2), hl(2, 2)];
    const f = fractals(cs, 2);
    expect(f.up.map((v, i) => (v == null ? null : i))).toEqual([null, null, 2, null, null, null, null, null, null]);
    expect(f.up[2]).toBe(6);
    expect(f.down[3]).toBe(0.5);
    // The last n bars cannot be fractals yet.
    expect(f.up.slice(-2).every((v) => v == null)).toBe(true);
  });
});

describe('new oscillators', () => {
  const wave = Array.from({ length: 120 }, (_, i) => k(100 + Math.sin(i / 5) * 6 + i * 0.05));

  it('stochastic RSI stays within 0..100 and %D smooths %K', () => {
    const { k: kk, d } = stochRsi(
      wave.map((c) => c.c),
      14,
      14,
      3,
      3,
    );
    const ks = kk.filter((v): v is number => v != null);
    expect(ks.length).toBeGreaterThan(80);
    for (const v of ks) expect(v >= -1e-9 && v <= 100 + 1e-9, String(v)).toBe(true);
    const i = 100;
    expect(d[i]).toBeCloseTo((kk[i]! + kk[i - 1]! + kk[i - 2]!) / 3, 9);
    // RSI's first value is at bar 14, its stochastic needs 14 of them, then two 3-bar averages.
    expect(kk.findIndex((v) => v != null)).toBe(14 + 13 + 2);
  });

  it('awesome oscillator = SMA(hl2, 5) − SMA(hl2, 34)', () => {
    const ao = awesome(wave, 5, 34);
    const hl2 = wave.map((c) => (c.h + c.l) / 2);
    const s5 = sma(hl2, 5);
    const s34 = sma(hl2, 34);
    expect(ao[32]).toBeNull();
    expect(ao[80]).toBeCloseTo(s5[80]! - s34[80]!, 9);
  });
});

describe('registry and settings', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('every indicator computes one value per candle for each output', () => {
    const cs = Array.from({ length: 80 }, (_, i) => k(100 + Math.sin(i / 3) * 4, undefined, undefined, i * 60_000));
    for (const def of INDICATORS.filter((d) => !d.overlay)) {
      const cfg = newIndicator(def.type)!;
      const out = def.compute(cs, cfg.params);
      for (const o of def.outputs) expect(out[o.key], `${def.type}.${o.key}`).toHaveLength(cs.length);
    }
  });

  it('labels show the parameters but not the Alligator offsets', () => {
    expect(indicatorLabel(newIndicator('ema')!)).toBe('MME 9');
    expect(indicatorLabel(newIndicator('alligator')!)).toBe('Alligator 13 8 5');
  });

  it('loads saved indicators, clamping params and dropping unknown types', () => {
    const saved = [
      { id: 'a', type: 'rsi', params: { length: 9999 }, colors: {}, visible: false },
      { id: 'b', type: 'nope', params: {}, colors: {} },
    ];
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(saved), setItem: () => {}, removeItem: () => {} });
    expect(loadIndicators()).toEqual([{ id: 'a', type: 'rsi', params: { length: 500 }, colors: { v: '#7e57c2' }, visible: false }]);
  });
});
