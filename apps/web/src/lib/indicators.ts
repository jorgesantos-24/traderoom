/**
 * Technical indicators, computed the way TradingView's built-ins compute them (Pine `ta.*`),
 * so values match what traders see there. Every series has one value per candle; `null`
 * where there isn't enough history yet.
 */
import type { Candle } from '@traderoom/shared';

export type Values = Array<number | null>;

// ---- building blocks (Pine equivalents) ----

const close = (c: readonly Candle[]): Values => c.map((k) => k.c);
const hl2 = (c: readonly Candle[]): Values => c.map((k) => (k.h + k.l) / 2);

/** ta.sma */
export function sma(src: Values, len: number): Values {
  const out: Values = new Array(src.length).fill(null);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (v == null) {
      sum = 0;
      count = 0;
      continue;
    }
    sum += v;
    count++;
    if (count > len) sum -= src[i - len]!;
    if (count >= len) out[i] = sum / len;
  }
  return out;
}

/** Exponential average seeded with the SMA of its first `len` values (ta.ema with alpha 2/(len+1), ta.rma with 1/len). */
function seededEma(src: Values, len: number, alpha: number): Values {
  const out: Values = new Array(src.length).fill(null);
  let prev: number | null = null;
  let seed = 0;
  let seen = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (v == null) continue;
    if (prev === null) {
      seed += v;
      seen++;
      if (seen === len) {
        prev = seed / len;
        out[i] = prev;
      }
    } else {
      prev = alpha * v + (1 - alpha) * prev;
      out[i] = prev;
    }
  }
  return out;
}

/** ta.ema */
export const ema = (src: Values, len: number): Values => seededEma(src, len, 2 / (len + 1));
/** ta.rma (Wilder's smoothing, also SMMA) */
export const rma = (src: Values, len: number): Values => seededEma(src, len, 1 / len);

/** ta.wma */
export function wma(src: Values, len: number): Values {
  const out: Values = new Array(src.length).fill(null);
  const denom = (len * (len + 1)) / 2;
  for (let i = len - 1; i < src.length; i++) {
    let s = 0;
    let ok = true;
    for (let j = 0; j < len; j++) {
      const v = src[i - j];
      if (v == null) {
        ok = false;
        break;
      }
      s += v * (len - j);
    }
    if (ok) out[i] = s / denom;
  }
  return out;
}

/** ta.stdev (population, like TradingView). */
export function stdev(src: Values, len: number): Values {
  const mean = sma(src, len);
  return src.map((_, i) => {
    const m = mean[i];
    if (m == null) return null;
    let s = 0;
    for (let j = 0; j < len; j++) s += (src[i - j]! - m) ** 2;
    return Math.sqrt(s / len);
  });
}

function rolling(src: Values, len: number, pick: (a: number, b: number) => number): Values {
  return src.map((_, i) => {
    if (i < len - 1) return null;
    let r = src[i];
    if (r == null) return null;
    for (let j = 1; j < len; j++) {
      const v = src[i - j];
      if (v == null) return null;
      r = pick(r, v);
    }
    return r;
  });
}
export const highest = (src: Values, len: number) => rolling(src, len, Math.max);
export const lowest = (src: Values, len: number) => rolling(src, len, Math.min);

/** ta.tr (true range; the first bar uses high − low). */
export function trueRange(c: readonly Candle[]): Values {
  return c.map((k, i) => {
    const prev = c[i - 1];
    if (!prev) return k.h - k.l;
    return Math.max(k.h - k.l, Math.abs(k.h - prev.c), Math.abs(k.l - prev.c));
  });
}

const sub = (a: Values, b: Values): Values => a.map((v, i) => (v == null || b[i] == null ? null : v - b[i]!));

// ---- indicators ----

export function rsi(src: Values, len: number): Values {
  const up: Values = src.map((v, i) => (i === 0 || v == null || src[i - 1] == null ? null : Math.max(v - src[i - 1]!, 0)));
  const down: Values = src.map((v, i) => (i === 0 || v == null || src[i - 1] == null ? null : Math.max(src[i - 1]! - v, 0)));
  const u = rma(up, len);
  const d = rma(down, len);
  return u.map((uv, i) => {
    const dv = d[i];
    if (uv == null || dv == null) return null;
    if (dv === 0) return 100;
    if (uv === 0) return 0;
    return 100 - 100 / (1 + uv / dv);
  });
}

export function macd(src: Values, fast: number, slow: number, signal: number) {
  const line = sub(ema(src, fast), ema(src, slow));
  const sig = ema(line, signal);
  return { macd: line, signal: sig, hist: sub(line, sig) };
}

export function bollinger(src: Values, len: number, mult: number) {
  const basis = sma(src, len);
  const dev = stdev(src, len);
  return {
    basis,
    upper: basis.map((b, i) => (b == null ? null : b + mult * dev[i]!)),
    lower: basis.map((b, i) => (b == null ? null : b - mult * dev[i]!)),
  };
}

/** Stochastic (TradingView "Stoch"): %K = SMA(raw, smoothK), %D = SMA(%K, d). */
export function stochastic(c: readonly Candle[], len: number, smoothK: number, dLen: number) {
  const hh = highest(
    c.map((k) => k.h),
    len,
  );
  const ll = lowest(
    c.map((k) => k.l),
    len,
  );
  const raw: Values = c.map((k, i) => {
    const h = hh[i];
    const l = ll[i];
    if (h == null || l == null) return null;
    return h === l ? 0 : (100 * (k.c - l)) / (h - l);
  });
  const k = sma(raw, smoothK);
  return { k, d: sma(k, dLen) };
}

/** CCI on the close, like TradingView's built-in study (the one XGlobal's chart uses). */
export function cci(src: Values, len: number): Values {
  const tp = src;
  const mean = sma(tp, len);
  return tp.map((v, i) => {
    const m = mean[i];
    if (m == null || v == null) return null;
    let dev = 0;
    for (let j = 0; j < len; j++) dev += Math.abs(tp[i - j]! - m);
    dev /= len;
    return dev === 0 ? 0 : (v - m) / (0.015 * dev);
  });
}

export function williamsR(c: readonly Candle[], len: number): Values {
  const hh = highest(
    c.map((k) => k.h),
    len,
  );
  const ll = lowest(
    c.map((k) => k.l),
    len,
  );
  return c.map((k, i) => {
    const h = hh[i];
    const l = ll[i];
    if (h == null || l == null) return null;
    return h === l ? 0 : (100 * (k.c - h)) / (h - l);
  });
}

export const atr = (c: readonly Candle[], len: number): Values => rma(trueRange(c), len);

export const momentum = (src: Values, len: number): Values =>
  src.map((v, i) => (i < len || v == null || src[i - len] == null ? null : v - src[i - len]!));

/** DMI/ADX as in TradingView's "DMI" built-in. */
export function dmi(c: readonly Candle[], len: number, adxLen: number) {
  const plusDM: Values = c.map((k, i) => {
    const p = c[i - 1];
    if (!p) return null;
    const up = k.h - p.h;
    const down = p.l - k.l;
    return up > down && up > 0 ? up : 0;
  });
  const minusDM: Values = c.map((k, i) => {
    const p = c[i - 1];
    if (!p) return null;
    const up = k.h - p.h;
    const down = p.l - k.l;
    return down > up && down > 0 ? down : 0;
  });
  const tr = trueRange(c).map((v, i) => (i === 0 ? null : v));
  const trur = rma(tr, len);
  const pRma = rma(plusDM, len);
  const mRma = rma(minusDM, len);
  const plus = pRma.map((v, i) => (v == null || trur[i] == null || trur[i] === 0 ? null : (100 * v) / trur[i]!));
  const minus = mRma.map((v, i) => (v == null || trur[i] == null || trur[i] === 0 ? null : (100 * v) / trur[i]!));
  const dx = plus.map((p, i) => {
    const m = minus[i];
    if (p == null || m == null) return null;
    const s = p + m;
    return Math.abs(p - m) / (s === 0 ? 1 : s);
  });
  return { plus, minus, adx: rma(dx, adxLen).map((v) => (v == null ? null : 100 * v)) };
}

/** Parabolic SAR, a line-for-line port of TradingView's ta.sar(start, increment, maximum). */
export function parabolicSar(c: readonly Candle[], start: number, inc: number, max: number): Values {
  const out: Values = new Array(c.length).fill(null);
  let result = NaN;
  let maxMin = NaN;
  let acc = NaN;
  let isBelow = false;
  for (let i = 1; i < c.length; i++) {
    const k = c[i]!;
    const p1 = c[i - 1]!;
    let firstTrendBar = false;
    if (i === 1) {
      if (k.c > p1.c) {
        isBelow = true;
        maxMin = k.h;
        result = p1.l;
      } else {
        isBelow = false;
        maxMin = k.l;
        result = p1.h;
      }
      firstTrendBar = true;
      acc = start;
    }
    result = result + acc * (maxMin - result);
    if (isBelow) {
      if (result > k.l) {
        firstTrendBar = true;
        isBelow = false;
        result = Math.max(k.h, maxMin);
        maxMin = k.l;
        acc = start;
      }
    } else if (result < k.h) {
      firstTrendBar = true;
      isBelow = true;
      result = Math.min(k.l, maxMin);
      maxMin = k.h;
      acc = start;
    }
    if (!firstTrendBar) {
      if (isBelow) {
        if (k.h > maxMin) {
          maxMin = k.h;
          acc = Math.min(acc + inc, max);
        }
      } else if (k.l < maxMin) {
        maxMin = k.l;
        acc = Math.min(acc + inc, max);
      }
    }
    if (isBelow) {
      result = Math.min(result, p1.l);
      if (i > 1) result = Math.min(result, c[i - 2]!.l);
    } else {
      result = Math.max(result, p1.h);
      if (i > 1) result = Math.max(result, c[i - 2]!.h);
    }
    out[i] = result;
  }
  return out;
}

/**
 * ta.supertrend(factor, atrPeriod) on hl2. Split in two series so each trend is its own line,
 * broken where it flips: `up` (support under the price) and `down` (resistance over it).
 */
export function supertrend(c: readonly Candle[], atrLen: number, factor: number) {
  const a = atr(c, atrLen);
  const up: Values = new Array(c.length).fill(null);
  const down: Values = new Array(c.length).fill(null);
  let prevLower = 0;
  let prevUpper = 0;
  let prevSt: number | null = null;
  for (let i = 0; i < c.length; i++) {
    const k = c[i]!;
    const v = a[i];
    if (v == null) {
      prevLower = 0;
      prevUpper = 0;
      prevSt = null;
      continue;
    }
    const src = (k.h + k.l) / 2;
    const prevClose = c[i - 1]?.c ?? k.c;
    let lower = src - factor * v;
    let upper = src + factor * v;
    lower = lower > prevLower || prevClose < prevLower ? lower : prevLower;
    upper = upper < prevUpper || prevClose > prevUpper ? upper : prevUpper;
    let dir: 1 | -1;
    if (a[i - 1] == null) dir = 1;
    else if (prevSt === prevUpper) dir = k.c > upper ? -1 : 1;
    else dir = k.c < lower ? 1 : -1;
    const st = dir === -1 ? lower : upper;
    if (dir === -1) up[i] = st;
    else down[i] = st;
    prevLower = lower;
    prevUpper = upper;
    prevSt = st;
  }
  return { up, down };
}

/** Middle of the highest high and lowest low over `len` bars (Ichimoku's donchian). */
function midRange(c: readonly Candle[], len: number): Values {
  const hh = highest(
    c.map((k) => k.h),
    len,
  );
  const ll = lowest(
    c.map((k) => k.l),
    len,
  );
  return hh.map((h, i) => (h == null || ll[i] == null ? null : (h + ll[i]!) / 2));
}

/**
 * Ichimoku Cloud as in TradingView's built-in. Values sit on the bar they are computed on; the
 * leading spans are drawn `displacement - 1` bars ahead and the lagging span as many back (outputOffset).
 */
export function ichimoku(c: readonly Candle[], conv: number, base: number, spanB: number) {
  const conversion = midRange(c, conv);
  const baseLine = midRange(c, base);
  return {
    conversion,
    base: baseLine,
    leadA: conversion.map((v, i) => (v == null || baseLine[i] == null ? null : (v + baseLine[i]!) / 2)),
    leadB: midRange(c, spanB),
    lagging: close(c),
  };
}

/**
 * Williams Fractals: a high above the `n` bars on each side, and the mirror for lows.
 * Known only `n` bars later; values sit on the fractal's own bar.
 */
export function fractals(c: readonly Candle[], n: number) {
  const up: Values = new Array(c.length).fill(null);
  const down: Values = new Array(c.length).fill(null);
  for (let i = n; i + n < c.length; i++) {
    const h = c[i]!.h;
    const l = c[i]!.l;
    let isUp = true;
    let isDown = true;
    for (let j = 1; j <= n; j++) {
      if (!(c[i - j]!.h < h && c[i + j]!.h < h)) isUp = false;
      if (!(c[i - j]!.l > l && c[i + j]!.l > l)) isDown = false;
    }
    if (isUp) up[i] = h;
    if (isDown) down[i] = l;
  }
  return { up, down };
}

/** Stochastic RSI (TradingView's built-in): %K = SMA(stoch(RSI), smoothK), %D = SMA(%K, smoothD). */
export function stochRsi(src: Values, rsiLen: number, stochLen: number, smoothK: number, smoothD: number) {
  const r = rsi(src, rsiLen);
  const hh = highest(r, stochLen);
  const ll = lowest(r, stochLen);
  const raw: Values = r.map((v, i) => {
    const h = hh[i];
    const l = ll[i];
    if (v == null || h == null || l == null) return null;
    return h === l ? 0 : (100 * (v - l)) / (h - l);
  });
  const k = sma(raw, smoothK);
  return { k, d: sma(k, smoothD) };
}

/** Awesome Oscillator: SMA(hl2, fast) - SMA(hl2, slow). */
export const awesome = (c: readonly Candle[], fast: number, slow: number): Values => sub(sma(hl2(c), fast), sma(hl2(c), slow));

// ---- registry ----

export interface ParamDef {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
  /** Number field (default), on/off switch (0/1) or a choice between `options`. */
  kind?: 'number' | 'toggle' | 'select';
  options?: Array<{ value: number; label: string }>;
  /** Section heading in the settings dialog. */
  group?: string;
}

export interface OutputDef {
  key: string;
  label: string;
  color: string;
  kind: 'line' | 'histogram' | 'dots';
  width?: 1 | 2 | 3;
  /** Gaps (null values) break the line instead of joining across them (Supertrend's two trends). */
  breaks?: boolean;
}

export interface IndicatorDef {
  type: string;
  name: string;
  /** Short name for the legend. */
  short: string;
  category: 'Tendências' | 'Padrões' | 'Tendência' | 'Osciladores' | 'Volatilidade';
  /** Drawn over the candles, or in its own pane below. */
  pane: 'main' | 'own';
  params: ParamDef[];
  outputs: OutputDef[];
  /** Reference levels drawn as dashed lines in the indicator's pane. */
  levels?: number[];
  /** Values follow the price scale (decimals like the asset) rather than a 0–100 style scale. */
  priceScaled?: boolean;
  /** Bars to shift an output forward in time (Alligator). */
  offsets?: Record<string, number>;
  /** Drawn by its own canvas layer (boxes, labels), not as series; outputs are just its colors. */
  overlay?: boolean;
  /** Params shown in the legend label (default: every number param). */
  labelKeys?: string[];
  compute(c: readonly Candle[], p: Record<string, number>): Record<string, Values>;
}

const P = (key: string, label: string, def: number, min = 1, max = 500, step = 1): ParamDef => ({
  key,
  label,
  default: def,
  min,
  max,
  step,
});
const T = (key: string, label: string, on: boolean, group?: string): ParamDef => ({
  key,
  label,
  default: on ? 1 : 0,
  min: 0,
  max: 1,
  step: 1,
  kind: 'toggle',
  group,
});
const S = (key: string, label: string, options: string[], def = 0, group?: string): ParamDef => ({
  key,
  label,
  default: def,
  min: 0,
  max: options.length - 1,
  step: 1,
  kind: 'select',
  options: options.map((l, value) => ({ value, label: l })),
  group,
});
const G = (group: string, p: ParamDef): ParamDef => ({ ...p, group });

export const INDICATORS: IndicatorDef[] = [
  {
    type: 'smc',
    name: 'Tendências',
    short: 'Tendências',
    category: 'Tendências',
    pane: 'main',
    overlay: true,
    priceScaled: true,
    labelKeys: ['swingLen', 'internalLen'],
    params: [
      S('mode', 'Modo', ['Histórico', 'Atual'], 0, 'Geral'),
      T('internal', 'Estrutura interna', true, 'Estrutura'),
      G('Estrutura', P('internalLen', 'Período interno', 5, 2, 50)),
      T('swing', 'Estrutura swing', true, 'Estrutura'),
      G('Estrutura', P('swingLen', 'Período swing', 50, 10, 200)),
      T('swingPoints', 'Topos e fundos (HH/HL/LH/LL)', false, 'Estrutura'),
      T('strongWeak', 'Topo/fundo forte e fraco', true, 'Estrutura'),
      G('Order blocks', P('internalObs', 'Order blocks internos', 5, 0, 20)),
      G('Order blocks', P('swingObs', 'Order blocks swing', 0, 0, 20)),
      S('obMitigation', 'Invalidação', ['Fechamento', 'Pavio'], 1, 'Order blocks'),
      T('fvg', 'Fair value gaps (FVG)', false, 'Fair value gaps'),
      T('fvgAuto', 'Filtro automático', true, 'Fair value gaps'),
      G('Fair value gaps', P('fvgExtend', 'Extensão (velas)', 10, 1, 500)),
      T('equal', 'Topos/fundos iguais (EQH/EQL)', true, 'Liquidez'),
      G('Liquidez', P('eqLen', 'Período EQH/EQL', 3, 1, 20)),
      G('Liquidez', P('eqThreshold', 'Tolerância (× ATR)', 0.1, 0, 0.5, 0.01)),
      T('zones', 'Premium / equilíbrio / desconto', false, 'Zonas'),
      T('prevDay', 'Máx./mín. do dia anterior', false, 'Níveis'),
      T('prevWeek', 'Máx./mín. da semana anterior', false, 'Níveis'),
    ],
    outputs: [
      { key: 'bull', label: 'Estrutura de alta', color: '#089981', kind: 'line' },
      { key: 'bear', label: 'Estrutura de baixa', color: '#f23645', kind: 'line' },
      { key: 'obBull', label: 'Order block de alta', color: '#2962ff', kind: 'line' },
      { key: 'obBear', label: 'Order block de baixa', color: '#ff5d8f', kind: 'line' },
      { key: 'fvgBull', label: 'FVG de alta', color: '#00c853', kind: 'line' },
      { key: 'fvgBear', label: 'FVG de baixa', color: '#ff1744', kind: 'line' },
      { key: 'equal', label: 'EQH / EQL', color: '#ff9800', kind: 'line' },
      { key: 'levels', label: 'Níveis diário/semanal', color: '#b0b3bc', kind: 'line' },
    ],
    compute: () => ({}),
  },
  {
    type: 'patterns',
    name: 'Padrões gráficos (todos)',
    short: 'Padrões',
    category: 'Padrões',
    pane: 'main',
    overlay: true,
    priceScaled: true,
    labelKeys: ['depth'],
    params: [
      S('show', 'Mostrar', ['Todos', 'À espera', 'Último à espera'], 2, 'Geral'),
      T('targets', 'Alvos de preço', true, 'Geral'),
      T('inProgress', 'Em formação (antes do rompimento)', true, 'Geral'),
      G('Geral', P('depth', 'Profundidade (velas)', 5, 2, 30)),
      G('Geral', P('minAtr', 'Altura mínima (× ATR)', 2, 0.5, 10, 0.5)),
      T('double', 'Topo / fundo duplo', true, 'Padrões'),
      T('triple', 'Topo / fundo triplo', true, 'Padrões'),
      T('headShoulders', 'Ombro-cabeça-ombro (e invertido)', true, 'Padrões'),
      T('wedge', 'Cunhas (ascendente / descendente)', true, 'Padrões'),
      T('triangle', 'Triângulos', true, 'Padrões'),
      T('rectangle', 'Retângulos', true, 'Padrões'),
      T('flag', 'Bandeiras', true, 'Padrões'),
      T('pennant', 'Flâmulas', true, 'Padrões'),
      T('cup', 'Xícara com alça (e invertida)', true, 'Padrões'),
    ],
    outputs: [
      // One color per figure (as on TradingView), so overlapping patterns stay apart.
      { key: 'double', label: 'Topo / fundo duplo', color: '#2962ff', kind: 'line' },
      { key: 'triple', label: 'Topo / fundo triplo', color: '#00bcd4', kind: 'line' },
      { key: 'headShoulders', label: 'Ombro-cabeça-ombro', color: '#ab47bc', kind: 'line' },
      { key: 'wedge', label: 'Cunhas', color: '#ff9800', kind: 'line' },
      { key: 'triangle', label: 'Triângulos', color: '#fdd835', kind: 'line' },
      { key: 'rectangle', label: 'Retângulos', color: '#66bb6a', kind: 'line' },
      { key: 'flag', label: 'Bandeiras', color: '#ef5350', kind: 'line' },
      { key: 'pennant', label: 'Flâmulas', color: '#ff80ab', kind: 'line' },
      { key: 'cup', label: 'Xícara com alça', color: '#d4a373', kind: 'line' },
    ],
    compute: () => ({}),
  },
  {
    type: 'sma',
    name: 'Média Móvel Simples (MMS)',
    short: 'MMS',
    category: 'Tendência',
    pane: 'main',
    priceScaled: true,
    params: [P('length', 'Período', 20)],
    outputs: [{ key: 'v', label: 'MMS', color: '#2962ff', kind: 'line', width: 2 }],
    compute: (c, p) => ({ v: sma(close(c), p.length!) }),
  },
  {
    type: 'ema',
    name: 'Média Móvel Exponencial (MME)',
    short: 'MME',
    category: 'Tendência',
    pane: 'main',
    priceScaled: true,
    params: [P('length', 'Período', 9)],
    outputs: [{ key: 'v', label: 'MME', color: '#f5a524', kind: 'line', width: 2 }],
    compute: (c, p) => ({ v: ema(close(c), p.length!) }),
  },
  {
    type: 'wma',
    name: 'Média Móvel Ponderada (MMP)',
    short: 'MMP',
    category: 'Tendência',
    pane: 'main',
    priceScaled: true,
    params: [P('length', 'Período', 20)],
    outputs: [{ key: 'v', label: 'MMP', color: '#b37feb', kind: 'line', width: 2 }],
    compute: (c, p) => ({ v: wma(close(c), p.length!) }),
  },
  {
    type: 'bb',
    name: 'Bandas de Bollinger',
    short: 'BB',
    category: 'Volatilidade',
    pane: 'main',
    priceScaled: true,
    params: [P('length', 'Período', 20), P('mult', 'Desvio padrão', 2, 0.1, 10, 0.1)],
    outputs: [
      { key: 'basis', label: 'Base', color: '#2962ff', kind: 'line' },
      { key: 'upper', label: 'Superior', color: '#f23645', kind: 'line' },
      { key: 'lower', label: 'Inferior', color: '#089981', kind: 'line' },
    ],
    compute: (c, p) => bollinger(close(c), p.length!, p.mult!),
  },
  {
    type: 'sar',
    name: 'Parabolic SAR',
    short: 'SAR',
    category: 'Tendência',
    pane: 'main',
    priceScaled: true,
    params: [
      P('start', 'Início', 0.02, 0.001, 1, 0.001),
      P('inc', 'Incremento', 0.02, 0.001, 1, 0.001),
      P('max', 'Máximo', 0.2, 0.01, 1, 0.01),
    ],
    outputs: [{ key: 'v', label: 'SAR', color: '#2962ff', kind: 'dots' }],
    compute: (c, p) => ({ v: parabolicSar(c, p.start!, p.inc!, p.max!) }),
  },
  {
    type: 'alligator',
    name: 'Alligator (Williams)',
    short: 'Alligator',
    category: 'Tendência',
    pane: 'main',
    priceScaled: true,
    params: [
      P('jaw', 'Mandíbula', 13),
      P('jawOffset', 'Desloc. mandíbula', 8, 0, 50),
      P('teeth', 'Dentes', 8),
      P('teethOffset', 'Desloc. dentes', 5, 0, 50),
      P('lips', 'Lábios', 5),
      P('lipsOffset', 'Desloc. lábios', 3, 0, 50),
    ],
    outputs: [
      { key: 'jaw', label: 'Mandíbula', color: '#2962ff', kind: 'line' },
      { key: 'teeth', label: 'Dentes', color: '#e91e63', kind: 'line' },
      { key: 'lips', label: 'Lábios', color: '#66bb6a', kind: 'line' },
    ],
    compute: (c, p) => ({ jaw: rma(hl2(c), p.jaw!), teeth: rma(hl2(c), p.teeth!), lips: rma(hl2(c), p.lips!) }),
  },
  {
    type: 'donchian',
    name: 'Canal Donchian',
    short: 'DC',
    category: 'Volatilidade',
    pane: 'main',
    priceScaled: true,
    params: [P('length', 'Período', 20)],
    outputs: [
      { key: 'upper', label: 'Superior', color: '#2962ff', kind: 'line' },
      { key: 'basis', label: 'Base', color: '#ff6d00', kind: 'line' },
      { key: 'lower', label: 'Inferior', color: '#2962ff', kind: 'line' },
    ],
    compute: (c, p) => {
      const upper = highest(
        c.map((k) => k.h),
        p.length!,
      );
      const lower = lowest(
        c.map((k) => k.l),
        p.length!,
      );
      return { upper, lower, basis: upper.map((u, i) => (u == null ? null : (u + lower[i]!) / 2)) };
    },
  },
  {
    type: 'rsi',
    name: 'Índice de Força Relativa (IFR/RSI)',
    short: 'RSI',
    category: 'Osciladores',
    pane: 'own',
    params: [P('length', 'Período', 14)],
    outputs: [{ key: 'v', label: 'RSI', color: '#7e57c2', kind: 'line', width: 2 }],
    levels: [70, 50, 30],
    compute: (c, p) => ({ v: rsi(close(c), p.length!) }),
  },
  {
    type: 'macd',
    name: 'MACD',
    short: 'MACD',
    category: 'Osciladores',
    pane: 'own',
    priceScaled: true,
    params: [P('fast', 'Rápida', 12), P('slow', 'Lenta', 26), P('signal', 'Sinal', 9)],
    outputs: [
      { key: 'hist', label: 'Histograma', color: '#26a69a', kind: 'histogram' },
      { key: 'macd', label: 'MACD', color: '#2962ff', kind: 'line', width: 2 },
      { key: 'signal', label: 'Sinal', color: '#ff6d00', kind: 'line', width: 2 },
    ],
    levels: [0],
    compute: (c, p) => macd(close(c), p.fast!, p.slow!, p.signal!),
  },
  {
    type: 'stoch',
    name: 'Estocástico',
    short: 'Stoch',
    category: 'Osciladores',
    pane: 'own',
    params: [P('length', '%K Período', 14), P('smoothK', '%K Suavização', 3), P('d', '%D Período', 3)],
    outputs: [
      { key: 'k', label: '%K', color: '#2962ff', kind: 'line', width: 2 },
      { key: 'd', label: '%D', color: '#ff6d00', kind: 'line', width: 2 },
    ],
    levels: [80, 20],
    compute: (c, p) => stochastic(c, p.length!, p.smoothK!, p.d!),
  },
  {
    type: 'cci',
    name: 'Índice de Canal de Commodities (CCI)',
    short: 'CCI',
    category: 'Osciladores',
    pane: 'own',
    params: [P('length', 'Período', 20)],
    outputs: [{ key: 'v', label: 'CCI', color: '#2962ff', kind: 'line', width: 2 }],
    levels: [100, 0, -100],
    compute: (c, p) => ({ v: cci(close(c), p.length!) }),
  },
  {
    type: 'williams',
    name: 'Williams %R',
    short: '%R',
    category: 'Osciladores',
    pane: 'own',
    params: [P('length', 'Período', 14)],
    outputs: [{ key: 'v', label: '%R', color: '#7e57c2', kind: 'line', width: 2 }],
    levels: [-20, -50, -80],
    compute: (c, p) => ({ v: williamsR(c, p.length!) }),
  },
  {
    type: 'adx',
    name: 'Índice Direcional (DMI/ADX)',
    short: 'DMI',
    category: 'Tendência',
    pane: 'own',
    params: [P('length', 'Período DI', 14), P('adxLen', 'Suavização ADX', 14)],
    outputs: [
      { key: 'adx', label: 'ADX', color: '#ff6d00', kind: 'line', width: 2 },
      { key: 'plus', label: '+DI', color: '#2962ff', kind: 'line' },
      { key: 'minus', label: '−DI', color: '#f23645', kind: 'line' },
    ],
    compute: (c, p) => dmi(c, p.length!, p.adxLen!),
  },
  {
    type: 'atr',
    name: 'Amplitude Média Real (ATR)',
    short: 'ATR',
    category: 'Volatilidade',
    pane: 'own',
    priceScaled: true,
    params: [P('length', 'Período', 14)],
    outputs: [{ key: 'v', label: 'ATR', color: '#b71c1c', kind: 'line', width: 2 }],
    compute: (c, p) => ({ v: atr(c, p.length!) }),
  },
  {
    type: 'mom',
    name: 'Momentum',
    short: 'Mom',
    category: 'Osciladores',
    pane: 'own',
    priceScaled: true,
    params: [P('length', 'Período', 10)],
    outputs: [{ key: 'v', label: 'Mom', color: '#2962ff', kind: 'line', width: 2 }],
    levels: [0],
    compute: (c, p) => ({ v: momentum(close(c), p.length!) }),
  },
  {
    type: 'supertrend',
    name: 'Supertrend',
    short: 'Supertrend',
    category: 'Tendência',
    pane: 'main',
    priceScaled: true,
    params: [P('atrLen', 'Período ATR', 10), P('factor', 'Fator', 3, 0.1, 20, 0.1)],
    outputs: [
      { key: 'up', label: 'Alta', color: '#089981', kind: 'line', width: 2, breaks: true },
      { key: 'down', label: 'Baixa', color: '#f23645', kind: 'line', width: 2, breaks: true },
    ],
    compute: (c, p) => supertrend(c, p.atrLen!, p.factor!),
  },
  {
    type: 'ichimoku',
    name: 'Ichimoku Cloud',
    short: 'Ichimoku',
    category: 'Tendência',
    pane: 'main',
    priceScaled: true,
    params: [
      P('conv', 'Linha de conversão', 9),
      P('base', 'Linha base', 26),
      P('spanB', 'Span B', 52),
      P('displacement', 'Deslocamento', 26, 1, 200),
    ],
    outputs: [
      { key: 'conversion', label: 'Conversão', color: '#2962ff', kind: 'line' },
      { key: 'base', label: 'Base', color: '#b71c1c', kind: 'line' },
      { key: 'lagging', label: 'Atrasada', color: '#43a047', kind: 'line' },
      { key: 'leadA', label: 'Span A', color: '#a5d6a7', kind: 'line' },
      { key: 'leadB', label: 'Span B', color: '#ef9a9a', kind: 'line' },
    ],
    compute: (c, p) => ichimoku(c, p.conv!, p.base!, p.spanB!),
  },
  {
    type: 'fractals',
    name: 'Fractais (Williams)',
    short: 'Fractais',
    category: 'Tendência',
    pane: 'main',
    overlay: true,
    params: [P('n', 'Períodos', 2, 1, 20)],
    outputs: [
      { key: 'up', label: 'Fractal de alta', color: '#089981', kind: 'dots' },
      { key: 'down', label: 'Fractal de baixa', color: '#f23645', kind: 'dots' },
    ],
    compute: (c, p) => fractals(c, p.n!),
  },
  {
    type: 'stochrsi',
    name: 'Estocástico RSI',
    short: 'Stoch RSI',
    category: 'Osciladores',
    pane: 'own',
    params: [P('smoothK', 'K', 3), P('smoothD', 'D', 3), P('rsiLen', 'Período RSI', 14), P('stochLen', 'Período estocástico', 14)],
    outputs: [
      { key: 'k', label: 'K', color: '#2962ff', kind: 'line', width: 2 },
      { key: 'd', label: 'D', color: '#ff6d00', kind: 'line', width: 2 },
    ],
    levels: [80, 50, 20],
    compute: (c, p) => stochRsi(close(c), p.rsiLen!, p.stochLen!, p.smoothK!, p.smoothD!),
  },
  {
    type: 'ao',
    name: 'Awesome Oscillator',
    short: 'AO',
    category: 'Osciladores',
    pane: 'own',
    priceScaled: true,
    params: [P('fast', 'Rápida', 5), P('slow', 'Lenta', 34)],
    outputs: [{ key: 'v', label: 'AO', color: '#089981', kind: 'histogram' }],
    levels: [0],
    compute: (c, p) => ({ v: awesome(c, p.fast!, p.slow!) }),
  },
];

export const INDICATOR_BY_TYPE = new Map(INDICATORS.map((d) => [d.type, d]));

/** Bars an output is drawn shifted by: Alligator lines forward by their offset params, Ichimoku's spans. */
export function outputOffset(def: IndicatorDef, outputKey: string, params: Record<string, number>): number {
  if (def.type === 'ichimoku') {
    const d = Math.round(params.displacement ?? 26) - 1;
    if (outputKey === 'leadA' || outputKey === 'leadB') return d;
    if (outputKey === 'lagging') return -d;
    return 0;
  }
  if (def.type !== 'alligator') return 0;
  return Math.round(params[`${outputKey}Offset`] ?? 0);
}

// ---- user configuration ----

export interface IndicatorConfig {
  id: string;
  type: string;
  params: Record<string, number>;
  colors: Record<string, string>;
  visible: boolean;
}

export function newIndicator(type: string): IndicatorConfig | null {
  const def = INDICATOR_BY_TYPE.get(type);
  if (!def) return null;
  return {
    id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    type,
    params: Object.fromEntries(def.params.map((p) => [p.key, p.default])),
    colors: Object.fromEntries(def.outputs.map((o) => [o.key, o.color])),
    visible: true,
  };
}

/** Legend label, e.g. "MME 9" or "BB 20 2". */
export function indicatorLabel(cfg: IndicatorConfig): string {
  const def = INDICATOR_BY_TYPE.get(cfg.type);
  if (!def) return cfg.type;
  const shown = def.labelKeys
    ? def.labelKeys.flatMap((k) => def.params.filter((p) => p.key === k))
    : def.params.filter((p) => !p.key.endsWith('Offset') && (p.kind ?? 'number') === 'number');
  const params = shown.map((p) => cfg.params[p.key] ?? p.default);
  return `${def.short} ${params.join(' ')}`;
}

/**
 * Saved per asset: { [symbol]: IndicatorConfig[] }. Each asset has its own indicators, so one
 * added on BTC is not on ETH until it is added there too.
 * v3 (2026-11-14) replaced the single list of v1/v2; those saves are dropped on load.
 */
export const INDICATORS_KEY = 'kyden.indicators.v3';
const KEY = INDICATORS_KEY;
const OLD_KEYS = ['kyden.indicators.v1', 'kyden.indicators.v2'];

export type IndicatorMap = Readonly<Record<string, readonly IndicatorConfig[]>>;

/** One asset's saved list: known types only, each at most once, params clamped. */
function parseList(list: unknown): IndicatorConfig[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  return list.flatMap((v): IndicatorConfig[] => {
    const c = v as IndicatorConfig;
    const def = typeof c?.type === 'string' ? INDICATOR_BY_TYPE.get(c.type) : undefined;
    if (!def || typeof c.id !== 'string' || seen.has(c.type)) return [];
    seen.add(c.type);
    // Fill params/colors added since it was saved, and clamp what was stored.
    const params = Object.fromEntries(
      def.params.map((p) => {
        const n = Number(c.params?.[p.key]);
        return [p.key, Number.isFinite(n) ? Math.min(p.max, Math.max(p.min, n)) : p.default];
      }),
    );
    const colors = Object.fromEntries(
      def.outputs.map((o) => [o.key, typeof c.colors?.[o.key] === 'string' ? c.colors[o.key]! : o.color]),
    );
    return [{ id: c.id, type: c.type, params, colors, visible: c.visible !== false }];
  });
}

export function loadIndicators(): IndicatorMap {
  try {
    for (const k of OLD_KEYS) localStorage.removeItem(k);
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const map: unknown = JSON.parse(raw);
    if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
    return Object.fromEntries(
      Object.entries(map as Record<string, unknown>)
        .map(([symbol, list]) => [symbol, parseList(list)] as const)
        .filter(([, list]) => list.length > 0),
    );
  } catch {
    return {};
  }
}

export function saveIndicators(map: IndicatorMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // storage blocked: indicators just won't survive a reload
  }
}
