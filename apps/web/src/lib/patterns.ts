/**
 * Classic chart patterns, our own detector: double/triple tops and bottoms, head and shoulders,
 * wedges, triangles, rectangles, flags, pennants and cup and handle.
 *
 * Built the way TradingView's auto patterns are described: 5/5 pivots (a bar higher or lower than
 * the 5 on each side), patterns joining the pivots that frame the price (tops with only lower highs
 * between them; lines that every candle stays inside), a close through the breakout line to
 * confirm. Confirmed patterns are stamped at the breakout bar and never repaint; later bars only
 * move them to "reached", "failed" or "expired". With "in progress" on, patterns that are still
 * forming (no breakout yet) are shown too, dotted; those can still change or vanish.
 */
import type { Candle } from '@traderoom/shared';
import { adaptiveAtr, legTurn, type Dir } from './smc';

export type PatternType =
  | 'doubleTop'
  | 'doubleBottom'
  | 'tripleTop'
  | 'tripleBottom'
  | 'headShoulders'
  | 'inverseHeadShoulders'
  | 'risingWedge'
  | 'fallingWedge'
  | 'ascendingTriangle'
  | 'descendingTriangle'
  | 'symmetricalTriangle'
  | 'rectangle'
  | 'bullFlag'
  | 'bearFlag'
  | 'bullPennant'
  | 'bearPennant'
  | 'cupHandle'
  | 'invertedCupHandle';

export type PatternFamily = 'double' | 'triple' | 'headShoulders' | 'wedge' | 'triangle' | 'rectangle' | 'flag' | 'pennant' | 'cup';

export const PATTERN_NAME: Record<PatternType, string> = {
  doubleTop: 'Topo duplo',
  doubleBottom: 'Fundo duplo',
  tripleTop: 'Topo triplo',
  tripleBottom: 'Fundo triplo',
  headShoulders: 'Ombro-cabeça-ombro',
  inverseHeadShoulders: 'OCO invertido',
  risingWedge: 'Cunha ascendente',
  fallingWedge: 'Cunha descendente',
  ascendingTriangle: 'Triângulo ascendente',
  descendingTriangle: 'Triângulo descendente',
  symmetricalTriangle: 'Triângulo simétrico',
  rectangle: 'Retângulo',
  bullFlag: 'Bandeira de alta',
  bearFlag: 'Bandeira de baixa',
  bullPennant: 'Flâmula de alta',
  bearPennant: 'Flâmula de baixa',
  cupHandle: 'Xícara com alça',
  invertedCupHandle: 'Xícara invertida',
};

const FAMILY: Record<PatternType, PatternFamily> = {
  doubleTop: 'double',
  doubleBottom: 'double',
  tripleTop: 'triple',
  tripleBottom: 'triple',
  headShoulders: 'headShoulders',
  inverseHeadShoulders: 'headShoulders',
  risingWedge: 'wedge',
  fallingWedge: 'wedge',
  ascendingTriangle: 'triangle',
  descendingTriangle: 'triangle',
  symmetricalTriangle: 'triangle',
  rectangle: 'rectangle',
  bullFlag: 'flag',
  bearFlag: 'flag',
  bullPennant: 'pennant',
  bearPennant: 'pennant',
  cupHandle: 'cup',
  invertedCupHandle: 'cup',
};

/** When two patterns break out on the same bar and overlap, the more specific one wins. */
const PRIORITY: Record<PatternFamily, number> = {
  headShoulders: 1,
  triple: 2,
  cup: 3,
  wedge: 4,
  triangle: 4.1,
  rectangle: 4.2,
  flag: 5,
  pennant: 5,
  double: 6,
};

/** A point on the chart: candle index and price. */
export interface Pt {
  i: number;
  p: number;
}
export interface Line {
  a: Pt;
  b: Pt;
}

export interface Pattern {
  type: PatternType;
  family: PatternFamily;
  name: string;
  /** Expected direction after the breakout. */
  dir: Dir;
  /** Swing points, drawn as a polyline. */
  points: Pt[];
  /** Boundaries of channel-like patterns (wedges, triangles, rectangles, flags), up to the breakout. */
  upper?: Line;
  lower?: Line;
  neckline?: Line;
  cup?: { left: Pt; bottom: Pt; right: Pt };
  start: number;
  /** Bar whose close broke out, and that close. */
  breakout: Pt;
  target: number;
  /** A close back beyond this level kills the pattern. */
  invalidation: number;
  /** forming: no breakout yet ("in progress"); `breakout` is then the latest bar. */
  status: 'forming' | 'awaiting' | 'reached' | 'failed' | 'expired';
  statusAt: number | null;
}

export interface PatternOptions {
  /** Bars on the right that confirm a swing point. */
  depth: number;
  /** Minimum pattern height, in ATRs. */
  minAtr: number;
  /** Also report patterns that have not broken out yet. */
  inProgress: boolean;
  families: Record<PatternFamily, boolean>;
}

export const ALL_FAMILIES: Record<PatternFamily, boolean> = {
  double: true,
  triple: true,
  headShoulders: true,
  wedge: true,
  triangle: true,
  rectangle: true,
  flag: true,
  pennant: true,
  cup: true,
};

export const DEFAULT_PATTERNS: PatternOptions = { depth: 5, minAtr: 2, inProgress: true, families: ALL_FAMILIES };

export interface SwingPoint {
  idx: number;
  price: number;
  kind: 'H' | 'L';
  /** Bar at which it became known. */
  at: number;
}

/**
 * Pivots: a bar whose high (low) no bar within `len` on either side beats; equal values only
 * count on the left, so a flat top gives one pivot. Known `len` bars later.
 */
export function pivots(c: readonly Candle[], len: number): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let i = len; i + len < c.length; i++) {
    let hi = true;
    let lo = true;
    for (let j = i - len; j <= i + len && (hi || lo); j++) {
      if (j === i) continue;
      if (j < i ? c[j]!.h > c[i]!.h : c[j]!.h >= c[i]!.h) hi = false;
      if (j < i ? c[j]!.l < c[i]!.l : c[j]!.l <= c[i]!.l) lo = false;
    }
    if (hi) out.push({ idx: i, price: c[i]!.h, kind: 'H', at: i + len });
    if (lo) out.push({ idx: i, price: c[i]!.l, kind: 'L', at: i + len });
  }
  return out;
}

/** Alternating swing highs and lows (same zigzag as the SMC structure); used for flags and cups. */
export function zigzag(c: readonly Candle[], len: number): SwingPoint[] {
  const out: SwingPoint[] = [];
  let leg: Dir | 0 = 0;
  for (let k = 0; k < c.length; k++) {
    const t = legTurn(c, k, len, leg);
    if (!t) continue;
    leg = t === 'high' ? -1 : 1;
    const p = k - len;
    out.push({ idx: p, price: t === 'high' ? c[p]!.h : c[p]!.l, kind: t === 'high' ? 'H' : 'L', at: k });
  }
  return out;
}

export const lineAt = (l: Line, i: number): number => (l.b.i === l.a.i ? l.a.p : l.a.p + ((l.b.p - l.a.p) * (i - l.a.i)) / (l.b.i - l.a.i));
const pt = (z: SwingPoint): Pt => ({ i: z.idx, p: z.price });

type Candidate = Omit<Pattern, 'family' | 'name' | 'status' | 'statusAt'> & {
  forming?: boolean;
  /** Tie-break between same-family candidates breaking on the same bar (lower wins). */
  pref?: number;
  /** Pivot bars a wedge, triangle or rectangle is drawn through. */
  touches?: number[];
};

/** Longest pattern searched, in bars (TradingView searches the latest 600). */
const MAX_SPAN = 300;
/** Tops (bottoms) count as equal within this share of the pattern height. */
const DEV = 0.15;
/** The move into the first top must be at least this share of the pattern height. */
const TREND = 0.3;
/**
 * Wedge, triangle and rectangle rules, tuned against TradingView's "All chart patterns" on BTC, ETH,
 * SOL and XRP (5m, 2026-11-07). Exported so a comparison script can try other values; the app never
 * changes them.
 */
export const CHANNEL_TUNING = {
  /**
   * Each touch must stand out from the price around it by this share of the pattern height (see
   * `prominence`). This is what keeps small wiggles inside a range from becoming touches, which
   * TradingView's coarser zigzag never uses.
   */
  promHeight: 0.4,
  /** Share of the way to the apex after which a converging pattern can no longer break out. */
  apexShare: 0.85,
  /** How far back (share of the width) a sloped line may be drawn before its first touch. */
  leadShare: 0.5,
};

type Scan = { kind: 'break'; k: number; dir: Dir } | { kind: 'open' } | null;

export function findPatterns(c: readonly Candle[], o: PatternOptions = DEFAULT_PATTERNS): Pattern[] {
  const n = c.length;
  if (n < 20) return [];
  const depth = Math.max(2, Math.round(o.depth));
  const atr = adaptiveAtr(c, 14);
  const P = pivots(c, depth);
  const Z = zigzag(c, depth);
  const on = o.families;
  const minH = (i: number) => o.minAtr * atr[i]!;
  const cands: Candidate[] = [];
  const last = n - 1;

  /**
   * Walks bars from `from` to `until`: the first one `step` decides is the breakout ('fail' ends it).
   * Running out of data before `until` means the pattern is still forming.
   */
  const watch = (from: number, until: number, step: (k: number) => Dir | 'fail' | null): Scan => {
    for (let k = Math.max(0, from); k <= Math.min(until, last); k++) {
      const r = step(k);
      if (r === 'fail') return null;
      if (r) return { kind: 'break', k, dir: r };
    }
    return until > last ? { kind: 'open' } : null;
  };
  const scan = (from: number, until: number, step: (k: number) => Dir | 'fail' | null): { k: number; dir: Dir } | null => {
    const r = watch(from, until, step);
    return r?.kind === 'break' ? { k: r.k, dir: r.dir } : null;
  };
  /** Adds a candidate from a watch() result; forming ones end on the latest bar. */
  const emit = (r: Scan, dir: Dir, make: (endIdx: number, close: number) => Omit<Candidate, 'breakout' | 'dir' | 'forming'>) => {
    if (!r) return;
    if (r.kind === 'break') cands.push({ ...make(r.k, c[r.k]!.c), dir: r.dir, breakout: { i: r.k, p: c[r.k]!.c } });
    else if (o.inProgress) cands.push({ ...make(last, c[last]!.c), dir, breakout: { i: last, p: c[last]!.c }, forming: true });
  };

  for (const s of [1, -1] as Dir[]) {
    // s = 1: tops (bearish patterns) on highs; s = -1: bottoms, mirrored so one code path does both.
    const v = (x: number) => s * x;
    const vh = (k: number) => (s === 1 ? c[k]!.h : -c[k]!.l);
    const vl = (k: number) => (s === 1 ? c[k]!.l : -c[k]!.h);
    const lowest = (from: number, to: number) => {
      let best = from;
      for (let k = from; k <= to; k++) if (vl(k) < vl(best)) best = k;
      return best;
    };
    const tops = P.filter((z) => z.kind === (s === 1 ? 'H' : 'L'));
    const trendInto = (a: SwingPoint, span: number, height: number) => {
      let m = Infinity;
      for (let k = Math.max(0, a.idx - span); k < a.idx; k++) m = Math.min(m, vl(k));
      return v(a.price) - m >= TREND * height;
    };
    const flip = -s as Dir;

    // ---- double and triple tops / bottoms ----
    if (on.double || on.triple) {
      for (let bi = 0; bi < tops.length; bi++) {
        const B = tops[bi]!;
        // Earlier tops that pair with B: nothing between them reaches higher (beyond the tolerance).
        const pairs: Array<{ A: SwingPoint; mid: number; height: number }> = [];
        let k = B.idx - 1;
        let runMax = -Infinity;
        let runMin = Infinity;
        let runMinIdx = -1;
        for (let ai = bi - 1; ai >= 0 && pairs.length < 2; ai--) {
          const A = tops[ai]!;
          if (B.idx - A.idx > MAX_SPAN) break;
          for (; k > A.idx; k--) {
            runMax = Math.max(runMax, vh(k));
            if (vl(k) < runMin) {
              runMin = vl(k);
              runMinIdx = k;
            }
          }
          const hi = Math.max(v(A.price), v(B.price));
          const lo = Math.min(v(A.price), v(B.price));
          if (runMax > hi) break;
          const height = hi - runMin;
          if (B.idx - A.idx < 2 * depth || height < minH(B.idx)) continue;
          if (hi - lo > DEV * height || runMax > lo + DEV * height) continue;
          pairs.push({ A, mid: runMinIdx, height });
        }
        if (pairs.length === 0) continue;

        if (pairs.length === 2 && on.triple) {
          const [near, far] = pairs as [(typeof pairs)[0], (typeof pairs)[0]];
          const height = far.height;
          const tops3 = [far.A, near.A, B].map((z) => v(z.price));
          const t1 = lowest(far.A.idx + 1, near.A.idx - 1);
          const t2 = lowest(near.A.idx + 1, B.idx - 1);
          const hi = Math.max(...tops3);
          const deep = [t1, t2].every((t) => vl(t) <= hi - 0.6 * height);
          if (hi - Math.min(...tops3) <= 0.1 * height && deep && trendInto(far.A, B.idx - far.A.idx, height)) {
            const neck = s * vl(far.mid);
            const r = watch(B.at, B.idx + (B.idx - far.A.idx) / 2, (x) =>
              v(c[x]!.c) < v(neck) ? flip : v(c[x]!.c) > v(B.price) ? 'fail' : null,
            );
            emit(r, flip, (end) => ({
              type: s === 1 ? 'tripleTop' : 'tripleBottom',
              points: [pt(far.A), { i: t1, p: s * vl(t1) }, pt(near.A), { i: t2, p: s * vl(t2) }, pt(B)],
              neckline: { a: { i: far.A.idx, p: neck }, b: { i: end, p: neck } },
              start: far.A.idx,
              target: neck - s * height,
              invalidation: B.price,
            }));
            continue;
          }
        }
        if (!on.double) continue;
        const { A, mid, height } = pairs[0]!;
        if (!trendInto(A, B.idx - A.idx, height)) continue;
        const neck = s * vl(mid);
        const r = watch(B.at, B.idx + (B.idx - A.idx), (x) => (v(c[x]!.c) < v(neck) ? flip : v(c[x]!.c) > v(B.price) ? 'fail' : null));
        emit(r, flip, (end) => ({
          type: s === 1 ? 'doubleTop' : 'doubleBottom',
          points: [pt(A), { i: mid, p: neck }, pt(B)],
          neckline: { a: { i: A.idx, p: neck }, b: { i: end, p: neck } },
          start: A.idx,
          target: neck - s * height,
          invalidation: B.price,
        }));
      }
    }

    // ---- head and shoulders ----
    if (on.headShoulders) {
      for (let ri = 0; ri < tops.length; ri++) {
        const RS = tops[ri]!;
        const maxH = (from: number, to: number) => {
          let m = -Infinity;
          for (let x = from; x <= to; x++) m = Math.max(m, vh(x));
          return m;
        };
        // Head: the nearest earlier top above the right shoulder that tops everything up to it,
        // with the rise from the neckline trough into the shoulder staying under the shoulder.
        let hiIdx = -1;
        for (let ai = ri - 1; ai >= 0; ai--) {
          const A = tops[ai]!;
          if (RS.idx - A.idx > MAX_SPAN) break;
          if (v(A.price) <= v(RS.price) || maxH(A.idx + 1, RS.idx - 1) >= v(A.price)) continue;
          const t = lowest(A.idx + 1, RS.idx - 1);
          if (maxH(t, RS.idx - 1) <= v(RS.price)) hiIdx = ai;
          break;
        }
        if (hiIdx < 0) continue;
        const head = tops[hiIdx]!;
        // Left shoulder: an earlier top under the head; the fall from it into the trough stays under it.
        for (let li = hiIdx - 1; li >= 0; li--) {
          const LS = tops[li]!;
          if (RS.idx - LS.idx > MAX_SPAN) break;
          if (v(LS.price) >= v(head.price)) break;
          const n1 = lowest(LS.idx + 1, head.idx - 1);
          if (maxH(LS.idx + 1, n1) > v(LS.price)) continue;
          const n2 = lowest(head.idx + 1, RS.idx - 1);
          const neck: Line = { a: { i: n1, p: s * vl(n1) }, b: { i: n2, p: s * vl(n2) } };
          const vN = (i: number) => v(lineAt(neck, i));
          const hN = v(head.price) - vN(head.idx);
          const t1 = head.idx - LS.idx;
          const t2 = RS.idx - head.idx;
          const ok =
            hN >= minH(head.idx) &&
            v(head.price) > Math.max(v(LS.price), v(RS.price)) + 0.15 * hN &&
            v(LS.price) - vN(LS.idx) >= 0.3 * hN &&
            v(RS.price) - vN(RS.idx) >= 0.3 * hN &&
            Math.abs(LS.price - RS.price) <= 0.4 * hN &&
            Math.abs(neck.a.p - neck.b.p) <= 0.5 * hN &&
            t1 <= 3 * t2 &&
            t2 <= 3 * t1 &&
            trendInto(LS, RS.idx - LS.idx, hN);
          if (!ok) continue;
          const r = watch(RS.at, RS.idx + (RS.idx - LS.idx) / 2, (x) =>
            v(c[x]!.c) < vN(x) ? flip : v(c[x]!.c) > v(RS.price) ? 'fail' : null,
          );
          emit(r, flip, (end) => ({
            type: s === 1 ? 'headShoulders' : 'inverseHeadShoulders',
            points: [pt(LS), neck.a, pt(head), neck.b, pt(RS)],
            neckline: { a: { i: LS.idx, p: lineAt(neck, LS.idx) }, b: { i: end, p: lineAt(neck, end) } },
            start: LS.idx,
            target: lineAt(neck, end) - s * hN,
            invalidation: RS.price,
          }));
          break;
        }
      }
    }
  }

  // ---- wedges, triangles, rectangles: two lines through pivots that frame every candle between ----
  if (on.wedge || on.triangle || on.rectangle) {
    // A line may be pierced by wicks (up to half an ATR) but closes must stay on its side.
    const frames = (l: Line, from: number, to: number, side: 'upper' | 'lower') => {
      for (let k = from; k <= to; k++) {
        const y = lineAt(l, k);
        const x = c[k]!;
        const out = side === 'upper' ? Math.max(x.c - y, (x.h - y) / 3.3) : Math.max(y - x.c, (y - x.l) / 3.3);
        if (out > 0.15 * atr[k]!) return false;
      }
      return true;
    };
    /**
     * How far a pivot stands out: from a high, the deepest dip on each side before price trades above
     * it again (mirrored for lows); the smaller side counts. Small wiggles inside a range score low,
     * real swing points high, much as a zigzag keeps only the turns that matter.
     */
    const prominence = (z: SwingPoint) => {
      const side = (step: 1 | -1) => {
        let dip = 0;
        for (let k = z.idx + step, m = 0; k >= 0 && k < n && m < MAX_SPAN; k += step, m++) {
          const x = c[k]!;
          if (z.kind === 'H' ? x.h > z.price : x.l < z.price) return dip;
          dip = Math.max(dip, z.kind === 'H' ? z.price - x.l : x.h - z.price);
        }
        return dip;
      };
      return Math.min(side(-1), side(1));
    };
    const T = CHANNEL_TUNING;
    const prom = new Map(P.map((z) => [z, prominence(z)]));
    const linesOf = (kind: 'H' | 'L') => {
      const pts = P.filter((z) => z.kind === kind);
      const out: Array<{ line: Line; a: SwingPoint; b: SwingPoint }> = [];
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i]!;
          const b = pts[j]!;
          if (b.idx - a.idx > MAX_SPAN) break;
          if (b.idx - a.idx < 2 * depth) continue;
          const line = { a: pt(a), b: pt(b) };
          if (frames(line, a.idx, b.idx, kind === 'H' ? 'upper' : 'lower')) out.push({ line, a, b });
        }
      }
      return out;
    };
    const uppers = linesOf('H');
    const lowers = linesOf('L');
    for (const u of uppers) {
      for (const d of lowers) {
        // The touches must interleave: each line has a touch inside the other's span.
        if (!(d.a.idx < u.b.idx && u.a.idx < d.b.idx)) continue;
        const U = u.line;
        const L = d.line;
        const start = Math.min(u.a.idx, d.a.idx);
        const end = Math.max(u.b.idx, d.b.idx);
        const width = end - start;
        if (width > MAX_SPAN || width < 4 * depth) continue;
        const hS = lineAt(U, start) - lineAt(L, start);
        const hE = lineAt(U, end) - lineAt(L, end);
        if (hE <= 0 || hS < minH(start)) continue;
        if (!frames(U, start, end, 'upper') || !frames(L, start, end, 'lower')) continue;

        const dU = lineAt(U, end) - lineAt(U, start);
        const dL = lineAt(L, end) - lineAt(L, start);
        const flat = 0.03 * hS;
        const fU = Math.abs(dU) <= flat;
        const fL = Math.abs(dL) <= flat;
        const converging = hE < 0.8 * hS;
        let type: PatternType | null = null;
        if (fU && fL) type = 'rectangle';
        else if (converging) {
          if (fU && dL > 0) type = 'ascendingTriangle';
          else if (dU < 0 && fL) type = 'descendingTriangle';
          else if (dU < 0 && dL > 0) type = 'symmetricalTriangle';
          else if (dU > 0 && dL > dU) type = 'risingWedge';
          else if (dL < 0 && dU < dL) type = 'fallingWedge';
        }
        if (!type || !on[FAMILY[type]]) continue;
        const kind = type;
        const wedge = kind === 'risingWedge' || kind === 'fallingWedge';

        const apex = converging ? start + (width * hS) / (hS - hE) : Infinity;
        // Near the apex the lines have met: a close "through" them there is noise, not a breakout.
        // Textbook breaks come 2/3 to 3/4 of the way; TradingView still takes some a bit later.
        const lastBreak = Math.floor(start + T.apexShare * (apex - start));
        if (end >= lastBreak) continue;
        const until = Math.min(end + width, lastBreak);
        const r = watch(Math.max(u.b.at, d.b.at), until, (k) => {
          const up = c[k]!.c > lineAt(U, k);
          const down = c[k]!.c < lineAt(L, k);
          if (kind === 'risingWedge') return down ? -1 : up ? 'fail' : null;
          if (kind === 'fallingWedge') return up ? 1 : down ? 'fail' : null;
          return up ? 1 : down ? -1 : null;
        });
        // Triangles and rectangles have no direction until they break, so they are not shown forming.
        if (r?.kind === 'open' && !wedge) continue;
        const touches = [u.a, d.a, u.b, d.b].sort((x, y) => x.idx - y.idx);
        // Small wiggles are not touches: each one must stand out against the pattern's size.
        if (touches.some((z) => prom.get(z)! < T.promHeight * hS)) continue;
        // A sloped line drawn far back past its first touch frames nothing there.
        if ((!fU && u.a.idx - start > T.leadShare * width) || (!fL && d.a.idx - start > T.leadShare * width)) continue;
        const dir: Dir = kind === 'fallingWedge' ? 1 : -1;
        const bd: Dir = r?.kind === 'break' ? r.dir : dir;
        emit(r, dir, (endIdx, close) => ({
          type: kind,
          points: touches.map(pt),
          upper: { a: { i: start, p: lineAt(U, start) }, b: { i: endIdx, p: lineAt(U, endIdx) } },
          lower: { a: { i: start, p: lineAt(L, start) }, b: { i: endIdx, p: lineAt(L, endIdx) } },
          start,
          target: (r?.kind === 'break' ? close : bd === 1 ? lineAt(U, endIdx) : lineAt(L, endIdx)) + bd * hS,
          invalidation: bd === 1 ? Math.min(d.a.price, d.b.price) : Math.max(u.a.price, u.b.price),
          // Same breakout bar: prefer the frame whose touches are the most recent, then the tighter one.
          // The widest frame could reach back to an old extreme and give an unrealistic height and target.
          pref: -end * 1e6 - start,
          touches: touches.map((z) => z.idx),
        }));
      }
    }
  }

  // ---- flags and pennants: a sharp pole, then a short consolidation against it ----
  if (on.flag || on.pennant) {
    for (let j = 4; j < Z.length; j++) {
      const [p0, h0, x1, y1, x2] = [Z[j - 4]!, Z[j - 3]!, Z[j - 2]!, Z[j - 1]!, Z[j]!];
      const s: Dir = h0.kind === 'H' ? 1 : -1;
      const v = (x: number) => s * x;
      const pole = v(h0.price) - v(p0.price);
      const poleBars = h0.idx - p0.idx;
      const flagBars = x2.idx - h0.idx;
      if (pole < 1.5 * minH(h0.idx) || poleBars < 1 || flagBars > 4 * poleBars) continue;
      // A: the line against the pole's direction (through h0 and y1); B: the other side (x1, x2).
      const A: Line = { a: pt(h0), b: pt(y1) };
      const B: Line = { a: pt(x1), b: pt(x2) };
      const vA = (i: number) => v(lineAt(A, i));
      const vB = (i: number) => v(lineAt(B, i));
      const fh = vA(h0.idx) - vB(h0.idx);
      const fe = vA(x2.idx) - vB(x2.idx);
      if (fh <= 0 || fe <= 0 || pole < 2.5 * fh) continue;
      if (v(h0.price) - Math.min(v(x1.price), v(x2.price)) > 0.5 * pole) continue;
      const dA = vA(x2.idx) - vA(h0.idx);
      const dB = vB(x2.idx) - vB(h0.idx);
      const flat = 0.25 * fh;
      let type: PatternType | null = null;
      if (dA < 0 && dB > 0 && fe < 0.7 * fh) type = s === 1 ? 'bullPennant' : 'bearPennant';
      else if (dA <= flat && dB <= flat && Math.abs(dA - dB) <= 0.5 * fh && (dA < 0 || dB < 0)) type = s === 1 ? 'bullFlag' : 'bearFlag';
      if (!type || !on[FAMILY[type]]) continue;
      const br = scan(Math.max(x2.at, x2.idx + 1), x2.idx + flagBars + depth, (k) =>
        v(c[k]!.c) > vA(k) ? s : v(c[k]!.c) < vB(k) ? 'fail' : null,
      );
      if (!br) continue;
      const bc = c[br.k]!.c;
      const lineA: Line = { a: { i: h0.idx, p: lineAt(A, h0.idx) }, b: { i: br.k, p: lineAt(A, br.k) } };
      const lineB: Line = { a: { i: h0.idx, p: lineAt(B, h0.idx) }, b: { i: br.k, p: lineAt(B, br.k) } };
      cands.push({
        type,
        dir: s,
        points: [p0, h0, x1, y1, x2].map(pt),
        upper: s === 1 ? lineA : lineB,
        lower: s === 1 ? lineB : lineA,
        start: p0.idx,
        breakout: { i: br.k, p: bc },
        target: bc + s * pole,
        invalidation: s * Math.min(v(x1.price), v(x2.price)),
      });
    }
  }

  // ---- cup and handle: a rounded base between two equal rims, a small handle, then the break ----
  if (on.cup) {
    for (let ia = 0; ia < Z.length; ia++) {
      const a = Z[ia]!;
      const s: Dir = a.kind === 'H' ? 1 : -1;
      const v = (x: number) => s * x;
      const vh = (k: number) => (s === 1 ? c[k]!.h : -c[k]!.l);
      const vl = (k: number) => (s === 1 ? c[k]!.l : -c[k]!.h);
      for (let ib = ia + 2; ib < Math.min(Z.length - 1, ia + 40); ib += 2) {
        const b = Z[ib]!;
        const width = b.idx - a.idx;
        if (width < Math.max(15, 4 * depth)) continue;
        const rim = Math.min(v(a.price), v(b.price));
        let bottom = Infinity;
        let bi = -1;
        let roof = -Infinity;
        for (let k = a.idx + 1; k < b.idx; k++) {
          if (vl(k) < bottom) {
            bottom = vl(k);
            bi = k;
          }
          roof = Math.max(roof, vh(k));
        }
        const D = rim - bottom;
        if (D < 1.5 * minH(b.idx) || roof > rim + 0.1 * D || Math.abs(a.price - b.price) > 0.2 * D) continue;
        const f = (bi - a.idx) / width;
        if (f < 0.25 || f > 0.75) continue;
        // Rounded, not a V: a good share of the base trades near the bottom.
        let nearBottom = 0;
        for (let k = a.idx + 1; k < b.idx; k++) if (vl(k) <= bottom + 0.3 * D) nearBottom++;
        if (nearBottom < 0.2 * width) continue;
        const h = Z[ib + 1]!;
        const handle = v(b.price) - v(h.price);
        if (handle < 0.05 * D || handle > 0.5 * D || h.idx - b.idx > width / 2) continue;
        const br = scan(Math.max(h.at, h.idx + 1), h.idx + Math.ceil(width / 2), (k) =>
          v(c[k]!.c) > v(b.price) ? s : v(c[k]!.c) < v(h.price) ? 'fail' : null,
        );
        if (!br) continue;
        const bc = c[br.k]!.c;
        cands.push({
          type: s === 1 ? 'cupHandle' : 'invertedCupHandle',
          dir: s,
          points: [pt(b), pt(h)],
          cup: { left: pt(a), bottom: { i: bi, p: s * bottom }, right: pt(b) },
          neckline: { a: { i: a.idx, p: b.price }, b: { i: br.k, p: b.price } },
          start: a.idx,
          breakout: { i: br.k, p: bc },
          target: bc + s * D,
          invalidation: h.price,
        });
        break;
      }
    }
  }

  // Keep, per family, the first pattern to break out (no later find replaces an earlier one);
  // skip one that mostly covers the same bars as a kept one. Forming patterns come last.
  const order = (x: Candidate) => (x.forming ? n + 1 : x.breakout.i);
  cands.sort((x, y) => order(x) - order(y) || PRIORITY[FAMILY[x.type]] - PRIORITY[FAMILY[y.type]] || (x.pref ?? 0) - (y.pref ?? 0));
  // Wedges, triangles and rectangles are one shape when drawn through the same touches (2 of 4 for the
  // same kind, 3 of 4 across kinds): keep one. Frames through other touches are all shown, as on TradingView.
  const channel = (f: PatternFamily) => f === 'wedge' || f === 'triangle' || f === 'rectangle';
  const touchesOf = new Map<Pattern, number[]>();
  const kept: Pattern[] = [];
  for (const { forming, pref: _pref, touches, ...cand } of cands) {
    const fam = FAMILY[cand.type];
    const len = cand.breakout.i - cand.start;
    const clashes = kept.filter((k) => {
      if (channel(k.family) && channel(fam)) {
        // Lines through other touches are another shape, even of the same kind: TradingView shows both.
        const other = touchesOf.get(k) ?? [];
        const shared = (touches ?? []).filter((t) => other.includes(t)).length;
        if (shared < (k.family === fam ? 2 : 3)) return false;
      } else if (k.family !== fam) return false;
      const overlap = Math.min(k.breakout.i, cand.breakout.i) - Math.max(k.start, cand.start);
      return overlap > 0.5 * Math.max(len, k.breakout.i - k.start);
    });
    // A much bigger shape around smaller ones replaces them (TradingView shows the big picture).
    const swallows = clashes.every(
      (k) => k.start >= cand.start && k.breakout.i <= cand.breakout.i && len >= 1.5 * (k.breakout.i - k.start),
    );
    if (clashes.length && !swallows) continue;
    for (const k of clashes) kept.splice(kept.indexOf(k), 1);
    const p: Pattern = { ...cand, family: fam, name: PATTERN_NAME[cand.type], status: forming ? 'forming' : 'awaiting', statusAt: null };
    const done = forming ? p : settle(c, p);
    if (touches) touchesOf.set(done, touches);
    kept.push(done);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** Follows the pattern after its breakout: target reached, invalidated, or too old. */
function settle(c: readonly Candle[], p: Pattern): Pattern {
  const life = 3 * Math.max(10, p.breakout.i - p.start);
  for (let k = p.breakout.i + 1; k < c.length; k++) {
    const bar = c[k]!;
    if (p.dir === 1 ? bar.h >= p.target : bar.l <= p.target) return { ...p, status: 'reached', statusAt: k };
    if (p.dir === 1 ? bar.c < p.invalidation : bar.c > p.invalidation) return { ...p, status: 'failed', statusAt: k };
    if (k - p.breakout.i > life) return { ...p, status: 'expired', statusAt: k };
  }
  return p;
}

export type PatternShow = 'all' | 'awaiting' | 'last';

/**
 * Like TradingView's "Patterns" input: every live pattern, only those still awaiting their target
 * (forming ones included), or the latest awaiting one of each kind.
 */
export function visiblePatterns(list: readonly Pattern[], show: PatternShow): Pattern[] {
  const live = list.filter((p) => p.status === 'awaiting' || p.status === 'reached' || p.status === 'forming');
  if (show === 'all') return live;
  const waiting = live.filter((p) => p.status !== 'reached');
  if (show === 'awaiting') return waiting;
  const latest = new Map<PatternType, Pattern>();
  for (const p of waiting) if (!latest.has(p.type) || p.start > latest.get(p.type)!.start) latest.set(p.type, p);
  return [...latest.values()];
}

/** Indicator params -> options. */
export function patternSettings(p: Record<string, number>) {
  const on = (k: string) => (p[k] ?? 1) >= 0.5;
  const families = Object.fromEntries((Object.keys(ALL_FAMILIES) as PatternFamily[]).map((f) => [f, on(f)])) as Record<
    PatternFamily,
    boolean
  >;
  const show: PatternShow = (['all', 'awaiting', 'last'] as const)[Math.round(p.show ?? 2)] ?? 'last';
  return {
    options: {
      depth: p.depth ?? DEFAULT_PATTERNS.depth,
      minAtr: p.minAtr ?? DEFAULT_PATTERNS.minAtr,
      inProgress: on('inProgress'),
      families,
    } as PatternOptions,
    show,
    targets: on('targets'),
  };
}
