/**
 * Smart Money Concepts, our own implementation of the public concepts (market structure,
 * order blocks, fair value gaps, equal highs/lows, premium/discount).
 *
 * Everything is decided on closed candles and stamped at the bar where it became known,
 * so nothing repaints: running on a longer history only ever adds to what a shorter one found.
 * Indexes are positions in the candle array.
 */
import type { Candle } from '@traderoom/shared';

export type Dir = 1 | -1;
export type Level = 'internal' | 'swing';

export interface StructureBreak {
  level: Level;
  /** BOS continues the trend, CHoCH flips it. */
  kind: 'BOS' | 'CHoCH';
  dir: Dir;
  price: number;
  /** The swing that was broken. */
  from: number;
  /** The bar whose close broke it. */
  to: number;
}

export interface OrderBlock {
  level: Level;
  dir: Dir;
  top: number;
  bottom: number;
  from: number;
  /** Bar where it was born (the structure break). */
  at: number;
  /** Bar that invalidated it, or null while active. */
  end: number | null;
}

export interface FairValueGap {
  dir: Dir;
  /** Unfilled part; shrinks as price trades into it. */
  top: number;
  bottom: number;
  /** Original gap. */
  gapTop: number;
  gapBottom: number;
  from: number;
  end: number | null;
}

export interface EqualLevel {
  kind: 'EQH' | 'EQL';
  a: { idx: number; price: number };
  b: { idx: number; price: number };
  /** Bar whose wick took the liquidity, or null. */
  swept: number | null;
}

export interface SwingPoint {
  idx: number;
  price: number;
  dir: Dir;
  label: 'HH' | 'LH' | 'HL' | 'LL';
}

export interface SwingRange {
  top: number;
  topIdx: number;
  bottom: number;
  bottomIdx: number;
}

export interface SmcResult {
  structure: StructureBreak[];
  orderBlocks: OrderBlock[];
  fvgs: FairValueGap[];
  equal: EqualLevel[];
  swings: SwingPoint[];
  range: SwingRange | null;
  trend: { internal: Dir | 0; swing: Dir | 0 };
}

export interface SmcOptions {
  internalLen: number;
  swingLen: number;
  /** What invalidates an order block: a close through it, or any wick. */
  obMitigation: 'close' | 'wick';
  /** Keep only gaps left by an impulsive middle candle. */
  fvgAuto: boolean;
  eqLen: number;
  /** Two highs (lows) are "equal" within this many ATRs. */
  eqThreshold: number;
}

export const DEFAULT_SMC: SmcOptions = {
  internalLen: 5,
  swingLen: 50,
  obMitigation: 'wick',
  fvgAuto: true,
  eqLen: 3,
  eqThreshold: 0.1,
};

/** Candles taller than this many ATRs are spikes, not order blocks. */
const OB_MAX_ATR = 2;
/** "Impulsive": body above this multiple of the recent average body. */
const FVG_BODY_MULT = 1.5;
const FVG_BODY_WINDOW = 50;

/** ATR that exists from the first bar: Wilder smoothing with a growing window until `len`. */
export function adaptiveAtr(c: readonly Candle[], len: number): number[] {
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < c.length; i++) {
    const k = c[i]!;
    const p = c[i - 1];
    const tr = p ? Math.max(k.h - k.l, Math.abs(k.h - p.c), Math.abs(k.l - p.c)) : k.h - k.l;
    prev = i === 0 ? tr : prev + (tr - prev) / Math.min(i + 1, len);
    out.push(prev);
  }
  return out;
}

/**
 * Turning points of an alternating zigzag. The bar `len` back is a turn when it is beyond every
 * bar after it (higher high or lower low). Highs and lows must alternate: a new swing high only
 * after a swing low, so pullbacks inside a strong move don't count as swings.
 * Only bars up to `k` are read, so a turn never changes once printed.
 */
export function legTurn(c: readonly Candle[], k: number, len: number, leg: Dir | 0): 'high' | 'low' | null {
  const p = k - len;
  if (p < 0) return null;
  let maxH = -Infinity;
  let minL = Infinity;
  for (let j = p + 1; j <= k; j++) {
    if (c[j]!.h > maxH) maxH = c[j]!.h;
    if (c[j]!.l < minL) minL = c[j]!.l;
  }
  const high = c[p]!.h > maxH;
  const low = c[p]!.l < minL;
  // An outside bar can be both: the high wins (as on TradingView), so it never prints a low.
  if (high) return leg !== -1 ? 'high' : null;
  if (low && leg !== 1) return 'low';
  return null;
}

interface Pivot {
  price: number;
  idx: number;
  broken: boolean;
}
interface Tracker {
  level: Level;
  len: number;
  high: Pivot | null;
  low: Pivot | null;
  trend: Dir | 0;
  /** Zigzag direction: 1 after a swing low (rising), -1 after a swing high. */
  leg: Dir | 0;
}

/**
 * The block behind a break: the candle where the breaking move started, i.e. the lowest low
 * (bullish) or highest high (bearish) between the swing and the break. Abnormal spike candles
 * (range above OB_MAX_ATR × ATR) are skipped: a news wick is not where orders were placed.
 */
function findOrderBlock(c: readonly Candle[], atr: number[], from: number, to: number, dir: Dir, level: Level): OrderBlock | null {
  const pick = (skipSpikes: boolean) => {
    let x = -1;
    for (let i = from; i < to; i++) {
      const k = c[i]!;
      if (skipSpikes && k.h - k.l > OB_MAX_ATR * atr[i]!) continue;
      if (x < 0 || (dir === 1 ? k.l < c[x]!.l : k.h > c[x]!.h)) x = i;
    }
    return x;
  };
  let x = pick(true);
  if (x < 0) x = pick(false);
  if (x < 0) return null;
  const k = c[x]!;
  if (k.h <= k.l) return null;
  return { level, dir, top: k.h, bottom: k.l, from: x, at: to, end: null };
}

export function computeSmc(c: readonly Candle[], opts: SmcOptions = DEFAULT_SMC): SmcResult {
  const res: SmcResult = { structure: [], orderBlocks: [], fvgs: [], equal: [], swings: [], range: null, trend: { internal: 0, swing: 0 } };
  const n = c.length;
  if (n < 3) return res;
  const atr = adaptiveAtr(c, 200);
  const swing: Tracker = { level: 'swing', len: Math.max(2, Math.round(opts.swingLen)), high: null, low: null, trend: 0, leg: 0 };
  const internal: Tracker = { level: 'internal', len: Math.max(1, Math.round(opts.internalLen)), high: null, low: null, trend: 0, leg: 0 };
  const trackers = [swing, internal];
  const eqLen = Math.max(1, Math.round(opts.eqLen));
  let eqHigh: { idx: number; price: number } | null = null;
  let eqLow: { idx: number; price: number } | null = null;
  let eqLeg: Dir | 0 = 0;
  let lastSwingHigh: number | null = null;
  let lastSwingLow: number | null = null;
  let top: { price: number; idx: number } | null = null;
  let bottom: { price: number; idx: number } | null = null;
  let bodySum = 0;

  for (let k = 0; k < n; k++) {
    const bar = c[k]!;

    // 1. This bar against what is already on the chart.
    for (const ob of res.orderBlocks) {
      if (ob.end !== null) continue;
      if (
        ob.dir === 1
          ? (opts.obMitigation === 'close' ? bar.c : bar.l) < ob.bottom
          : (opts.obMitigation === 'close' ? bar.c : bar.h) > ob.top
      ) {
        ob.end = k;
      }
    }
    for (const g of res.fvgs) {
      if (g.end !== null) continue;
      if (g.dir === 1) {
        if (bar.l <= g.bottom) g.end = k;
        else if (bar.l < g.top) g.top = bar.l;
      } else if (bar.h >= g.top) g.end = k;
      else if (bar.h > g.bottom) g.bottom = bar.h;
    }
    for (const e of res.equal) {
      if (e.swept !== null) continue;
      if (e.kind === 'EQH' ? bar.h > Math.max(e.a.price, e.b.price) : bar.l < Math.min(e.a.price, e.b.price)) e.swept = k;
    }

    // 2. Pivots that this bar confirms (they sit `len` bars back, so their window ends here: no look-ahead).
    for (const t of trackers) {
      const p = k - t.len;
      if (p < 0) continue;
      const turn = legTurn(c, k, t.len, t.leg);
      if (turn === 'high') {
        t.leg = -1;
        const price = c[p]!.h;
        t.high = { price, idx: p, broken: false };
        if (t.level === 'swing') {
          if (lastSwingHigh !== null) res.swings.push({ idx: p, price, dir: 1, label: price > lastSwingHigh ? 'HH' : 'LH' });
          lastSwingHigh = price;
          top = { price, idx: p };
        }
      } else if (turn === 'low') {
        t.leg = 1;
        const price = c[p]!.l;
        t.low = { price, idx: p, broken: false };
        if (t.level === 'swing') {
          if (lastSwingLow !== null) res.swings.push({ idx: p, price, dir: -1, label: price < lastSwingLow ? 'LL' : 'HL' });
          lastSwingLow = price;
          bottom = { price, idx: p };
        }
      }
    }
    const pe = k - eqLen;
    const eqTurn = legTurn(c, k, eqLen, eqLeg);
    if (eqTurn) eqLeg = eqTurn === 'high' ? -1 : 1;
    if (pe >= 0) {
      if (eqTurn === 'high') {
        const cur = { idx: pe, price: c[pe]!.h };
        if (eqHigh && Math.abs(cur.price - eqHigh.price) < opts.eqThreshold * atr[pe]!) {
          res.equal.push({ kind: 'EQH', a: eqHigh, b: cur, swept: null });
        }
        eqHigh = cur;
      }
      if (eqTurn === 'low') {
        const cur = { idx: pe, price: c[pe]!.l };
        if (eqLow && Math.abs(cur.price - eqLow.price) < opts.eqThreshold * atr[pe]!) {
          res.equal.push({ kind: 'EQL', a: eqLow, b: cur, swept: null });
        }
        eqLow = cur;
      }
    }

    // 3. Trailing extremes of the current swing range.
    if (top && bar.h > top.price) top = { price: bar.h, idx: k };
    if (bottom && bar.l < bottom.price) bottom = { price: bar.l, idx: k };

    // 4. Structure: a close beyond the last unbroken swing.
    for (const t of trackers) {
      if (t.high && !t.high.broken && bar.c > t.high.price) {
        t.high.broken = true;
        const kind = t.trend === -1 ? 'CHoCH' : 'BOS';
        t.trend = 1;
        // An internal break of the very same swing is already drawn as the swing break.
        const dup = t.level === 'internal' && swing.high?.idx === t.high.idx;
        if (!dup) {
          res.structure.push({ level: t.level, kind, dir: 1, price: t.high.price, from: t.high.idx, to: k });
          const ob = findOrderBlock(c, atr, t.high.idx, k, 1, t.level);
          if (ob && !res.orderBlocks.some((o) => o.dir === 1 && o.from === ob.from)) res.orderBlocks.push(ob);
        }
      }
      if (t.low && !t.low.broken && bar.c < t.low.price) {
        t.low.broken = true;
        const kind = t.trend === 1 ? 'CHoCH' : 'BOS';
        t.trend = -1;
        const dup = t.level === 'internal' && swing.low?.idx === t.low.idx;
        if (!dup) {
          res.structure.push({ level: t.level, kind, dir: -1, price: t.low.price, from: t.low.idx, to: k });
          const ob = findOrderBlock(c, atr, t.low.idx, k, -1, t.level);
          if (ob && !res.orderBlocks.some((o) => o.dir === -1 && o.from === ob.from)) res.orderBlocks.push(ob);
        }
      }
    }

    // 5. Fair value gap left by the three bars ending here.
    if (k >= 2) {
      const a = c[k - 2]!;
      const mid = c[k - 1]!;
      const body = Math.abs(mid.c - mid.o);
      const window = Math.min(FVG_BODY_WINDOW, k - 1);
      const meanBody = window > 0 ? bodySum / window : 0;
      const impulsive = !opts.fvgAuto || window < 5 || body > FVG_BODY_MULT * meanBody;
      if (impulsive && bar.l > a.h && mid.c > a.h) {
        res.fvgs.push({ dir: 1, top: bar.l, bottom: a.h, gapTop: bar.l, gapBottom: a.h, from: k - 1, end: null });
      } else if (impulsive && bar.h < a.l && mid.c < a.l) {
        res.fvgs.push({ dir: -1, top: a.l, bottom: bar.h, gapTop: a.l, gapBottom: bar.h, from: k - 1, end: null });
      }
    }
    // Rolling sum of the bodies before the next middle bar (bars k-FVG_BODY_WINDOW+1 .. k-1 after this).
    if (k >= 1) {
      const prev = c[k - 1]!;
      bodySum += Math.abs(prev.c - prev.o);
      const drop = c[k - 1 - FVG_BODY_WINDOW];
      if (drop) bodySum -= Math.abs(drop.c - drop.o);
    }
  }

  res.trend = { internal: internal.trend, swing: swing.trend };
  if (top && bottom) res.range = { top: top.price, topIdx: top.idx, bottom: bottom.price, bottomIdx: bottom.idx };
  return res;
}

// ---- what to draw ----

export interface SmcView {
  mode: 'historical' | 'present';
  internal: boolean;
  swing: boolean;
  swingPoints: boolean;
  internalObs: number;
  swingObs: number;
  fvg: boolean;
  equal: boolean;
}

export interface SmcVisible {
  structure: StructureBreak[];
  orderBlocks: OrderBlock[];
  fvgs: FairValueGap[];
  equal: EqualLevel[];
  swings: SwingPoint[];
}

const lastN = <T>(list: T[], n: number) => (n <= 0 ? [] : list.slice(-n));

/** The subset to draw. "Present" keeps only the latest structure and what is still in play. */
export function visibleSmc(r: SmcResult, v: SmcView): SmcVisible {
  const present = v.mode === 'present';
  const structure = r.structure.filter((s) => (s.level === 'swing' ? v.swing : v.internal));
  const shownStructure = present
    ? (['internal', 'swing'] as const).flatMap((lvl) =>
        lastN(
          structure.filter((s) => s.level === lvl),
          1,
        ),
      )
    : structure;
  const active = r.orderBlocks.filter((o) => o.end === null);
  const orderBlocks = [
    ...lastN(
      active.filter((o) => o.level === 'internal'),
      v.internalObs,
    ),
    ...lastN(
      active.filter((o) => o.level === 'swing'),
      v.swingObs,
    ),
  ];
  const fvgs = v.fvg ? r.fvgs.filter((g) => g.end === null) : [];
  const equal = v.equal ? (present ? r.equal.filter((e) => e.swept === null) : r.equal) : [];
  const swings = v.swingPoints ? (present ? lastN(r.swings, 4) : r.swings) : [];
  return { structure: shownStructure.sort((a, b) => a.to - b.to), orderBlocks, fvgs: present ? lastN(fvgs, 5) : fvgs, equal, swings };
}

/** Previous day / week high and low, from daily candles (UTC days; weeks start on Monday, like Binance). */
export function previousLevels(daily: readonly Candle[], now: number) {
  const DAY = 86_400_000;
  const today = Math.floor(now / DAY) * DAY;
  const prevDay = daily.find((d) => d.t === today - DAY) ?? null;
  // 1970-01-01 was a Thursday: shift so weeks start on Monday.
  const weekStart = today - ((Math.floor(today / DAY) + 3) % 7) * DAY;
  const lastWeek = daily.filter((d) => d.t >= weekStart - 7 * DAY && d.t < weekStart);
  return {
    day: prevDay ? { high: prevDay.h, low: prevDay.l, start: prevDay.t } : null,
    week: lastWeek.length
      ? { high: Math.max(...lastWeek.map((d) => d.h)), low: Math.min(...lastWeek.map((d) => d.l)), start: weekStart - 7 * DAY }
      : null,
  };
}

/** Indicator params (numbers, toggles as 0/1) → detection options and drawing choices. */
export function smcSettings(p: Record<string, number>) {
  const on = (k: string, def = 1) => (p[k] ?? def) >= 0.5;
  const options: SmcOptions = {
    internalLen: p.internalLen ?? DEFAULT_SMC.internalLen,
    swingLen: p.swingLen ?? DEFAULT_SMC.swingLen,
    obMitigation: (p.obMitigation ?? 1) >= 0.5 ? 'wick' : 'close',
    fvgAuto: on('fvgAuto'),
    eqLen: p.eqLen ?? DEFAULT_SMC.eqLen,
    eqThreshold: p.eqThreshold ?? DEFAULT_SMC.eqThreshold,
  };
  const view: SmcView = {
    mode: (p.mode ?? 0) >= 0.5 ? 'present' : 'historical',
    internal: on('internal'),
    swing: on('swing'),
    swingPoints: on('swingPoints', 0),
    internalObs: Math.round(p.internalObs ?? 5),
    swingObs: Math.round(p.swingObs ?? 0),
    fvg: on('fvg', 0),
    equal: on('equal'),
  };
  return {
    options,
    view,
    fvgExtend: Math.round(p.fvgExtend ?? 10),
    zones: on('zones', 0),
    strongWeak: on('strongWeak'),
    prevDay: on('prevDay', 0),
    prevWeek: on('prevWeek', 0),
  };
}
