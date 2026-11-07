import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Candle } from '@traderoom/shared';
import {
  atr,
  bollinger,
  cci,
  ema,
  highest,
  INDICATORS,
  indicatorLabel,
  loadIndicators,
  lowest,
  macd,
  momentum,
  newIndicator,
  parabolicSar,
  rma,
  rsi,
  sma,
  stochastic,
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
