/**
 * Classic chart patterns, detected the way TradingView's built-in "Chart Pattern" indicators describe
 * themselves (support articles 43000653211 and the rest of the "Chart patterns" folder):
 *
 * - The search runs on the latest 600 bars. Every point is a 5/5 pivot (no higher high, or lower low,
 *   within 5 bars on each side).
 * - Points are joined by "price lines": consecutive points alternate high/low, and each line runs from
 *   the lowest low to the highest high of the bars it spans (or the reverse), as a zigzag does.
 * - A breakout is a close through the pattern's line. Before the breakout, no close may cross the
 *   pattern's lines. Patterns keep the status Awaiting until the price reaches the target (Reached) or
 *   comes back past the level that kills them (Failed); nothing expires.
 * - When two patterns of the same kind overlap, the Awaiting one wins, then the larger one (for tops and
 *   bottoms, the one whose tops are most alike).
 *
 * The tolerances are the defaults of TradingView's individual indicators (read from their inputs,
 * 2026-11-09), in `RULES`.
 */
import type { Candle } from '@traderoom/shared';
import type { Dir } from './smc';

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

/** TradingView has one indicator per kind; its three triangles are one ("Triangle"). */
export const patternKind = (t: PatternType): string => (FAMILY[t] === 'triangle' ? 'triangle' : t);

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
  /** Expected direction after the breakout (for a triangle or rectangle not broken yet, a guess). */
  dir: Dir;
  /** Swing points, drawn as a polyline. */
  points: Pt[];
  /** Boundaries of channel-like patterns (wedges, triangles, rectangles, flags, pennants), up to the breakout. */
  upper?: Line;
  lower?: Line;
  neckline?: Line;
  cup?: { left: Pt; bottom: Pt; right: Pt };
  start: number;
  /** Bar whose close broke out, and that close (the latest bar while forming). */
  breakout: Pt;
  target: number;
  /** Going back beyond this level kills the pattern. */
  invalidation: number;
  /** forming: no breakout yet ("in progress"). TradingView counts both forming and awaiting as Awaiting. */
  status: 'forming' | 'awaiting' | 'reached' | 'failed' | 'expired';
  statusAt: number | null;
}

export interface PatternOptions {
  /** Bars on each side that make a pivot (TradingView: 5). */
  depth: number;
  /** Minimum pattern height, in ATRs (0 = none, as on TradingView). */
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

export const DEFAULT_PATTERNS: PatternOptions = { depth: 5, minAtr: 0, inProgress: true, families: ALL_FAMILIES };

/**
 * TradingView's defaults (shares, 0..1). Exported so the comparison script can try other values; the
 * app never changes them.
 */
export const RULES = {
  /** Bars searched. */
  window: 600,
  /** Points are consecutive zigzag points (true) or any pivots joined by clean price lines (false). */
  zigzag: false,
  /** Overlap between two patterns of a kind (share of the smaller one's bars) that drops one. */
  overlap: 0,
  overlapPts: 0,
  awaitingFirst: true,
  /** Price lines from a pivot: at most this many (the nearest) next points. */
  maxSucc: 99,
  /** Of the shapes ending on one pivot, keep the one built from the nearest points. */
  nearestLast: true,
  nearestFamilies: ['wedge', 'triangle', 'rectangle'] as PatternFamily[],
  /** Wedges, triangles, rectangles: points joined by clean price lines; lines also contain the wicks. */
  channel: { legs: true, wicks: false, wickTol: 0 },
  // Trend height: TradingView says 50%, but its matches all sit at 0.7+ of the height measured here.
  double: { trend: 0.9, dev: 0.1 },
  triple: { trend: 0.9, tops: 0.1, minima: 0.5 },
  headShoulders: { trend: 0.9, headOver: 0.25, neckSlope: 0.15, shoulderHeight: 0.25, shoulderWidth: 0.6 },
  /** Channel Width Ratio Start/End: the end must be at least this much narrower than the start. */
  wedge: { ratio: 0.25, relEnd: false, anyStart: false },
  triangle: { dev: 0.05 },
  rectangle: { dev: 0.05 },
  flag: { dev: 0.15, rollback: 0.5 },
  pennant: { rollback: 0.8 },
  cup: { dev: 0.15, handle: 0.618, center: 0.5, minWidth: 20, round: 0.55 },
};

/** Overlap tie-break by size: -1 keeps the larger pattern, 1 the smaller (TradingView: larger). */
export const PREFER: Record<PatternFamily, number> = {
  double: -1,
  triple: -1,
  headShoulders: -1,
  wedge: -1,
  triangle: 1,
  rectangle: -1,
  flag: -1,
  pennant: -1,
  cup: -1,
};

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

/** Alternating pivots (a new pivot of the same kind replaces a weaker one). */
export function zigzag(c: readonly Candle[], len: number): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (const z of pivots(c, len)) {
    const last = out.at(-1);
    if (last && last.kind === z.kind) {
      if (z.kind === 'H' ? z.price > last.price : z.price < last.price) out[out.length - 1] = z;
    } else out.push(z);
  }
  return out;
}

export const lineAt = (l: Line, i: number): number => (l.b.i === l.a.i ? l.a.p : l.a.p + ((l.b.p - l.a.p) * (i - l.a.i)) / (l.b.i - l.a.i));

/** Range max / min in O(1) after O(n log n) setup. */
function sparse(v: Float64Array, max: boolean) {
  const n = v.length;
  const levels: Float64Array[] = [v];
  for (let w = 1; 2 * w <= n; w *= 2) {
    const prev = levels.at(-1)!;
    const next = new Float64Array(n - 2 * w + 1);
    for (let i = 0; i < next.length; i++) next[i] = max ? Math.max(prev[i]!, prev[i + w]!) : Math.min(prev[i]!, prev[i + w]!);
    levels.push(next);
  }
  return (a: number, b: number) => {
    if (a > b) return max ? -Infinity : Infinity;
    const k = 31 - Math.clz32(b - a + 1);
    const t = levels[k]!;
    const x = t[a]!;
    const y = t[b - (1 << k) + 1]!;
    return max ? Math.max(x, y) : Math.min(x, y);
  };
}

type Candidate = Omit<Pattern, 'family' | 'name' | 'status' | 'statusAt'> & {
  forming: boolean;
  /** Overlap tie-break, lower wins. */
  rank: number;
  /** Bar where the pattern's body ends (breakout, or the latest bar). */
  end: number;
  /** A close at or past this level after the breakout fails it (null: use `invalidation`). */
};

/** `debug`, when given, receives every candidate before overlapping ones are dropped. */
export function findPatterns(c: readonly Candle[], o: PatternOptions = DEFAULT_PATTERNS, debug?: Pattern[]): Pattern[] {
  const n = c.length;
  if (n < 20) return [];
  const depth = Math.max(2, Math.round(o.depth));
  const last = n - 1;
  const from = Math.max(0, n - RULES.window);
  const on = o.families;
  const R = RULES;

  const H = Float64Array.from(c, (x) => x.h);
  const L = Float64Array.from(c, (x) => x.l);
  const C = Float64Array.from(c, (x) => x.c);
  const maxH = sparse(H, true);
  const minL = sparse(L, false);

  // Optional size floor (off by default, as on TradingView).
  const atr = o.minAtr > 0 ? simpleAtr(c, 14) : null;
  const tooSmall = (height: number, i: number) => atr !== null && height < o.minAtr * atr[i]!;

  // Pivots in the window, by kind, with the "price line" successors of each.
  const P = pivots(c, depth).filter((z) => z.idx >= from);
  const next = new Map<SwingPoint, SwingPoint[]>();
  for (let i = 0; i < P.length; i++) {
    const a = P[i]!;
    const out: SwingPoint[] = [];
    for (let j = i + 1; j < P.length; j++) {
      const b = P[j]!;
      if (b.idx <= a.idx) continue;
      // The line from a low runs while nothing in between trades under it (mirrored from a high).
      // Only the low of the start bar and the high of the end bar count (not the other end of their range).
      if (a.kind === 'L' ? minL(a.idx + 1, b.idx - 1) < a.price : maxH(a.idx + 1, b.idx - 1) > a.price) break;
      if (b.kind === a.kind) continue;
      if (b.kind === 'H' ? maxH(a.idx + 1, b.idx) <= b.price : minL(a.idx + 1, b.idx) >= b.price) out.push(b);
      if (out.length >= R.maxSucc) break;
    }
    next.set(a, out);
  }
  // Consecutive zigzag points only (alternating pivots; of two in a row of one kind, the extreme).
  const Z: SwingPoint[] = [];
  for (const z of P) {
    const prev = Z.at(-1);
    if (prev && prev.kind === z.kind) {
      if (z.kind === 'H' ? z.price > prev.price : z.price < prev.price) Z[Z.length - 1] = z;
    } else Z.push(z);
  }
  const zNext = new Map<SwingPoint, SwingPoint[]>(Z.map((z, i) => [z, Z[i + 1] ? [Z[i + 1]!] : []]));
  const succ = (z: SwingPoint) => (R.zigzag ? (zNext.get(z) ?? []) : next.get(z)!);

  const cands: Candidate[] = [];
  const pt = (z: SwingPoint): Pt => ({ i: z.idx, p: z.price });

  for (const s of [1, -1] as Dir[]) {
    // s = 1: the bearish shapes (tops); s = -1: the same code on the mirrored chart (bottoms).
    const top: 'H' | 'L' = s === 1 ? 'H' : 'L';
    const bot: 'H' | 'L' = s === 1 ? 'L' : 'H';
    const v = (x: number) => s * x;
    const hiV = (k: number) => (s === 1 ? H[k]! : -L[k]!);
    const clV = (k: number) => s * C[k]!;
    const tops = P.filter((z) => z.kind === top);
    const bots = P.filter((z) => z.kind === bot);
    const flip = -s as Dir;

    /**
     * After the last point: the first close through `level(k)` (in the mirrored chart, under it) is the
     * breakout, unless the price first trades over `cap`. No breakout yet: still forming.
     */
    const breakDown = (after: number, level: (k: number) => number, cap: number): { k: number } | 'open' | null => {
      for (let k = after + 1; k <= last; k++) {
        if (hiV(k) > cap) return null;
        if (clV(k) < level(k)) return { k };
      }
      return 'open';
    };
    const push = (r: { k: number } | 'open' | null, make: (end: number) => Omit<Candidate, 'end' | 'forming' | 'breakout'>) => {
      if (!r || (r === 'open' && !o.inProgress)) return;
      const end = r === 'open' ? last : r.k;
      cands.push({ ...make(end), end, forming: r === 'open', breakout: { i: end, p: C[end]! } });
    };

    // ---- double tops / bottoms: start, top, trough, top ----
    if (on.double)
      for (const a0 of bots)
        for (const a1 of succ(a0))
          for (const a2 of succ(a1))
            for (const a3 of succ(a2)) {
              const t1 = v(a1.price);
              const t3 = v(a3.price);
              const neck = v(a2.price);
              const height = Math.max(t1, t3) - neck;
              if (height <= 0 || Math.abs(t1 - t3) > R.double.dev * height) continue;
              if (t1 - v(a0.price) < R.double.trend * height || tooSmall(height, a3.idx)) continue;
              const r = breakDown(a3.idx, () => neck, t3);
              push(r, (end) => ({
                type: s === 1 ? 'doubleTop' : 'doubleBottom',
                dir: flip,
                points: [pt(a0), pt(a1), pt(a2), pt(a3)],
                neckline: { a: { i: a1.idx, p: a2.price }, b: { i: end, p: a2.price } },
                start: a0.idx,
                target: s * (neck - height),
                invalidation: a3.price,
                // Tops most alike first.
                rank: Math.abs(t1 - t3) / height,
              }));
            }

    // ---- triple tops / bottoms and head and shoulders: start, top, trough, top, trough, top ----
    if (on.triple || on.headShoulders)
      for (const a0 of bots)
        for (const a1 of succ(a0))
          for (const a2 of succ(a1))
            for (const a3 of succ(a2))
              for (const a4 of succ(a3))
                for (const a5 of succ(a4)) {
                  const [v0, v1, v2, v3, v4, v5] = [a0, a1, a2, a3, a4, a5].map((z) => v(z.price)) as [number, number, number, number, number, number];
                  if (on.triple) {
                    const low = Math.min(v2, v4);
                    const peak = Math.max(v1, v3, v5);
                    const height = peak - low;
                    const hs = [v1, v3, v5].map((x) => x - low);
                    const d2 = peak - v2;
                    const d4 = peak - v4;
                    if (
                      height > 0 &&
                      Math.max(...hs) - Math.min(...hs) <= R.triple.tops * height &&
                      Math.abs(d2 - d4) <= R.triple.minima * Math.max(d2, d4) &&
                      v1 - v0 >= R.triple.trend * height &&
                      !tooSmall(height, a5.idx)
                    ) {
                      const r = breakDown(a5.idx, () => low, v5);
                      push(r, (end) => ({
                        type: s === 1 ? 'tripleTop' : 'tripleBottom',
                        dir: flip,
                        points: [a0, a1, a2, a3, a4, a5].map(pt),
                        neckline: { a: { i: a1.idx, p: s * low }, b: { i: end, p: s * low } },
                        start: a0.idx,
                        target: s * (low - height),
                        invalidation: a5.price,
                        rank: PREFER.triple * (a5.idx - a0.idx),
                      }));
                    }
                  }
                  if (on.headShoulders) {
                    const neck: Line = { a: { i: a2.idx, p: v2 }, b: { i: a4.idx, p: v4 } };
                    const hh = v3 - lineAt(neck, a3.idx);
                    const hl = v1 - lineAt(neck, a1.idx);
                    const hr = v5 - lineAt(neck, a5.idx);
                    const HS = R.headShoulders;
                    if (
                      hh > 0 &&
                      hl > 0 &&
                      hr > 0 &&
                      // The head stands out from the higher shoulder by a share of that shoulder.
                      hh >= (1 + HS.headOver) * Math.max(hl, hr) &&
                      Math.abs(v4 - v2) <= HS.neckSlope * hh &&
                      Math.abs(hl - hr) <= HS.shoulderHeight * hh &&
                      v1 - v0 >= HS.trend * hh &&
                      !tooSmall(hh, a5.idx)
                    ) {
                      const r = breakDown(a5.idx, (k) => lineAt(neck, k), v5);
                      // Shoulder widths: start to first trough, second trough to the break (or now).
                      const wl = a2.idx - a0.idx;
                      const wr = (r && r !== 'open' ? r.k : last) - a4.idx;
                      if (Math.abs(wl - wr) <= HS.shoulderWidth * Math.max(wl, wr))
                        push(r, (end) => ({
                          type: s === 1 ? 'headShoulders' : 'inverseHeadShoulders',
                          dir: flip,
                          points: [a0, a1, a2, a3, a4, a5].map(pt),
                          neckline: { a: { i: a1.idx, p: s * lineAt(neck, a1.idx) }, b: { i: end, p: s * lineAt(neck, end) } },
                          start: a0.idx,
                          target: s * (lineAt(neck, end) - hh),
                          invalidation: a5.price,
                          rank: PREFER.headShoulders * (a5.idx - a0.idx),
                        }));
                    }
                  }
                }

    // ---- flags and pennants: pole (start, tip), then three points against it ----
    // s = 1: pole up from a low (bullish); s = -1: the mirror.
    if (on.flag || on.pennant)
      for (const a0 of bots)
        for (const a1 of succ(a0))
          for (const a2 of succ(a1))
            for (const a3 of succ(a2))
              for (const a4 of succ(a3)) {
                const [v0, v1, v2, v3, v4] = [a0, a1, a2, a3, a4].map((z) => v(z.price)) as [number, number, number, number, number];
                const up = s;
                const pole = v1 - v0;
                if (pole <= 0) continue;
                if (v1 - Math.min(v2, v4) > R.flag.rollback * pole || tooSmall(pole, a1.idx)) continue;
                const A: Line = { a: { i: a1.idx, p: v1 }, b: { i: a3.idx, p: v3 } };
                const slopeA = (v3 - v1) / (a3.idx - a1.idx);
                let type: PatternType | null = null;
                let B: Line;
                // Flag: a parallel channel against the pole; the last point within the deviation of it.
                const height = lineAt(A, a2.idx) - v2;
                const par: Line = { a: { i: a2.idx, p: v2 }, b: { i: a2.idx + 1, p: v2 + slopeA } };
                if (on.flag && height > 0 && slopeA <= 0 && Math.abs(v4 - lineAt(par, a4.idx)) <= R.flag.dev * height) {
                  type = up === 1 ? 'bullFlag' : 'bearFlag';
                  B = par;
                } else {
                  // Pennant: a small triangle (falling top line, rising bottom line).
                  B = { a: { i: a2.idx, p: v2 }, b: { i: a4.idx, p: v4 } };
                  if (!on.pennant || !(slopeA < 0 && v4 > v2)) continue;
                  type = up === 1 ? 'bullPennant' : 'bearPennant';
                }
                const Bl = B;
                // No close through the lines between the tip and the last point.
                let inside = true;
                for (let k = a1.idx; k <= a4.idx && inside; k++) {
                  const x = clV(k);
                  if (x > lineAt(A, k) + 1e-12 || x < lineAt(Bl, k) - 1e-12) inside = false;
                }
                if (!inside) continue;
                const apex = type.endsWith('Pennant') ? apexOf(A, Bl) : Infinity;
                let r: { k: number } | 'open' | null = 'open';
                for (let k = a4.idx + 1; k <= last; k++) {
                  if (k >= apex) {
                    r = null;
                    break;
                  }
                  const x = clV(k);
                  if (x > lineAt(A, k)) {
                    r = { k };
                    break;
                  }
                  if (x < lineAt(Bl, k)) {
                    r = null;
                    break;
                  }
                }
                const t = type;
                push(r, (end) => ({
                  type: t,
                  dir: up,
                  points: [a0, a1, a2, a3, a4].map(pt),
                  upper: up === 1 ? flipLine(A, 1, a1.idx, end) : flipLine(Bl, -1, a1.idx, end),
                  lower: up === 1 ? flipLine(Bl, 1, a1.idx, end) : flipLine(A, -1, a1.idx, end),
                  start: a0.idx,
                  target: up * (clV(end) + pole),
                  invalidation: up * Math.min(v2, v4),
                  // Last two points closest to the far line first.
                  rank: Math.abs(v4 - lineAt(Bl, a4.idx)) / pole,
                }));
              }

    // ---- cup and handle: rim, bottom, rim, handle low ----
    // s = 1: the bullish cup (rims are highs); s = -1: the inverted one.
    if (on.cup)
      for (const a0 of tops)
        for (const a1 of succ(a0))
          for (const a2 of succ(a1)) {
            const width = a2.idx - a0.idx;
            if (width < R.cup.minWidth) continue;
            const rim = Math.min(v(a0.price), v(a2.price));
            const depthC = rim - v(a1.price);
            if (depthC <= 0 || Math.abs(v(a0.price) - v(a2.price)) > R.cup.dev * depthC || tooSmall(depthC, a2.idx)) continue;
            const mid = (a1.idx - a0.idx) / width;
            if (Math.abs(mid - 0.5) > R.cup.center / 2) continue;
            // A rounded bottom, not a V: closes stay under the rim and spend time in the lower half.
            let low = 0;
            let under = true;
            for (let k = a0.idx + 1; k < a2.idx && under; k++) {
              const x = clV(k);
              if (x > rim) under = false;
              if (x < rim - depthC / 2) low++;
            }
            if (!under || low < R.cup.round * width) continue;
            for (const a3 of succ(a2)) {
              if (v(a2.price) - v(a3.price) > R.cup.handle * depthC || a3.idx - a2.idx > width) continue;
              let r: { k: number } | 'open' | null = 'open';
              for (let k = a3.idx + 1; k <= last; k++) {
                if (k - a2.idx > width || v(s === 1 ? L[k]! : H[k]!) < v(a3.price)) {
                  r = null;
                  break;
                }
                if (clV(k) > v(a2.price)) {
                  r = { k };
                  break;
                }
              }
              const bottomIdx = a1.idx;
              push(r, (end) => ({
                type: s === 1 ? 'cupHandle' : 'invertedCupHandle',
                dir: s,
                points: [pt(a2), pt(a3)],
                cup: { left: pt(a0), bottom: { i: bottomIdx, p: a1.price }, right: pt(a2) },
                neckline: { a: { i: a0.idx, p: a2.price }, b: { i: end, p: a2.price } },
                start: a0.idx,
                target: C[end]! + s * depthC,
                invalidation: a3.price,
                rank: PREFER.cup * width,
              }));
              break;
            }
          }
  }

  // ---- wedges, triangles, rectangles: lines through alternating points, every close between them ----
  if (on.wedge || on.triangle || on.rectangle) {
    // Every close between the lines (`wicks`: every high and low, bar `a` and `b` aside).
    const closesInside = (U: Line, D: Line, a: number, b: number) => {
      for (let k = a; k <= b; k++) if (C[k]! > lineAt(U, k) + 1e-12 || C[k]! < lineAt(D, k) - 1e-12) return false;
      if (R.channel.wicks)
        for (let k = a + 1; k < b; k++) {
          const tol = R.channel.wickTol * (lineAt(U, k) - lineAt(D, k));
          if (H[k]! > lineAt(U, k) + tol || L[k]! < lineAt(D, k) - tol) return false;
        }
      return true;
    };
    /** Breakout after `after`: a close over U (1) or under D (-1); none before the apex: gone. */
    const breakOut = (U: Line, D: Line, after: number): { k: number; d: Dir } | 'open' | null => {
      const apex = apexOf(U, D);
      for (let k = after + 1; k <= last; k++) {
        if (k >= apex) return null;
        if (C[k]! > lineAt(U, k)) return { k, d: 1 };
        if (C[k]! < lineAt(D, k)) return { k, d: -1 };
      }
      return 'open';
    };
    const emit = (
      type: PatternType,
      pts: SwingPoint[],
      U: Line,
      D: Line,
      r: { k: number; d: Dir } | 'open' | null,
      guess: Dir,
      base: number,
    ) => {
      if (!r || (r === 'open' && !o.inProgress)) return;
      const start = pts[0]!.idx;
      const end = r === 'open' ? last : r.k;
      const dir: Dir = r === 'open' ? guess : r.d;
      const lastOpp = [...pts].reverse().find((z) => z.kind === (dir === 1 ? 'L' : 'H'))!;
      cands.push({
        type,
        dir,
        points: pts.map(pt),
        upper: { a: { i: start, p: lineAt(U, start) }, b: { i: end, p: lineAt(U, end) } },
        lower: { a: { i: start, p: lineAt(D, start) }, b: { i: end, p: lineAt(D, end) } },
        start,
        breakout: { i: end, p: C[end]! },
        target: (r === 'open' ? (dir === 1 ? lineAt(U, end) : lineAt(D, end)) : C[end]!) + dir * base,
        invalidation: lastOpp.price,
        end,
        forming: r === 'open',
        rank: PREFER[FAMILY[type]] * (pts.at(-1)!.idx - start),
      });
    };

    // Lines through two pivots of a kind with every close between them on the inner side. Unlike
    // the other patterns, the points here need not be joined by clean price lines (TradingView draws
    // wedges through pivots that a later bar pokes past).
    const lines = (kind: 'H' | 'L') => {
      const pts = P.filter((z) => z.kind === kind);
      const out: Array<{ a: SwingPoint; b: SwingPoint; line: Line }> = [];
      for (let i = 0; i < pts.length; i++)
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i]!;
          const b = pts[j]!;
          const line: Line = { a: pt(a), b: pt(b) };
          let ok = true;
          for (let k = a.idx; k <= b.idx && ok; k++) if (kind === 'H' ? C[k]! > lineAt(line, k) + 1e-12 : C[k]! < lineAt(line, k) - 1e-12) ok = false;
          if (ok) out.push({ a, b, line });
        }
      return out;
    };
    const ups = lines('H');
    const dns = lines('L');
    const W = R.wedge;
    const narrowEnough = (w0: number, w1: number) => (W.relEnd ? w0 - w1 >= W.ratio * w1 : w1 <= (1 - W.ratio) * w0);

    const pairs: Array<[{ a: SwingPoint; b: SwingPoint; line: Line }, { a: SwingPoint; b: SwingPoint; line: Line }]> = [];
    if (R.channel.legs)
      for (const a0 of P)
        for (const a1 of next.get(a0)!)
          for (const a2 of next.get(a1)!)
            for (const a3 of next.get(a2)!) {
              const mk = (a: SwingPoint, b: SwingPoint) => ({ a, b, line: { a: pt(a), b: pt(b) } });
              pairs.push([mk(a0, a2), mk(a1, a3)]);
            }
    else if (R.zigzag)
      for (let i = 0; i + 3 < Z.length; i++) {
        const mk = (a: SwingPoint, b: SwingPoint) => ({ a, b, line: { a: pt(a), b: pt(b) } });
        pairs.push([mk(Z[i]!, Z[i + 2]!), mk(Z[i + 1]!, Z[i + 3]!)]);
      }
    else
      for (const x of [...ups, ...dns])
        for (const y of x.a.kind === 'H' ? dns : ups) if (x.a.idx < y.a.idx && y.a.idx < x.b.idx && x.b.idx < y.b.idx) pairs.push([x, y]);

    // Four points: one line through the 1st and 3rd, the other through the 2nd and 4th.
    for (const [x, y] of pairs) {
        const four = [x.a, y.a, x.b, y.b];
        const [U, D] = x.a.kind === 'H' ? [x.line, y.line] : [y.line, x.line];
        const a0 = x.a.idx;
        const a3 = y.b.idx;
        const w0 = lineAt(U, a0) - lineAt(D, a0);
        const w3 = lineAt(U, a3) - lineAt(D, a3);
        if (w0 <= 0 || w3 <= 0 || tooSmall(w0, a3)) continue;
        if (!closesInside(U, D, a0, a3)) continue;

        // Rising wedge: starts on a low, both lines up, narrowing. Falling wedge: the mirror.
        if (on.wedge) {
          // TradingView's default point order: a rising wedge starts on a low, a falling one on a high
          // ("Change Pivots Sequence" off); `anyStart` accepts both.
          const rising = (W.anyStart || x.a.kind === 'L') && U.b.p > U.a.p && D.b.p > D.a.p;
          const falling = (W.anyStart || x.a.kind === 'H') && U.b.p < U.a.p && D.b.p < D.a.p;
          if ((rising || falling) && narrowEnough(w0, w3)) {
            const r = breakOut(U, D, a3);
            const want: Dir = rising ? -1 : 1;
            // A break the other way fails the wedge (it is not shown as awaiting).
            emit(rising ? 'risingWedge' : 'fallingWedge', four, U, D, r && r !== 'open' && r.d !== want ? null : r, want, w0);
          }
        }

        // Rectangle: flat lines at the outer high and low; the other two points close to them.
        if (on.rectangle) {
          const hs = four.filter((z) => z.kind === 'H').map((z) => z.price);
          const ls = four.filter((z) => z.kind === 'L').map((z) => z.price);
          const top = Math.max(...hs);
          const btm = Math.min(...ls);
          const h = top - btm;
          if (h > 0 && top - Math.min(...hs) <= R.rectangle.dev * h && Math.max(...ls) - btm <= R.rectangle.dev * h) {
            const Ur: Line = { a: { i: a0, p: top }, b: { i: a3, p: top } };
            const Dr: Line = { a: { i: a0, p: btm }, b: { i: a3, p: btm } };
            if (closesInside(Ur, Dr, a0, a3)) emit('rectangle', four, Ur, Dr, breakOut(Ur, Dr, a3), 1, h);
          }
        }
      }

    // Triangle: five points; the line through the 1st and 5th, the middle point of that side within
    // the deviation of it; the other line through the 2nd and 4th. Lines converge, not both one way.
    const tris: Array<[{ a: SwingPoint; b: SwingPoint; line: Line }, { a: SwingPoint; b: SwingPoint; line: Line }, SwingPoint | null]> = [];
    if (R.channel.legs)
      for (const a0 of P)
        for (const a1 of next.get(a0)!)
          for (const a2 of next.get(a1)!)
            for (const a3 of next.get(a2)!)
              for (const a4 of next.get(a3)!) {
                const mk = (a: SwingPoint, b: SwingPoint) => ({ a, b, line: { a: pt(a), b: pt(b) } });
                tris.push([mk(a0, a4), mk(a1, a3), a2]);
              }
    else if (R.zigzag)
      for (let i = 0; i + 4 < Z.length; i++) {
        const mk = (a: SwingPoint, b: SwingPoint) => ({ a, b, line: { a: pt(a), b: pt(b) } });
        tris.push([mk(Z[i]!, Z[i + 4]!), mk(Z[i + 1]!, Z[i + 3]!), Z[i + 2]!]);
      }
    else
      for (const A of [...ups, ...dns]) for (const B of A.a.kind === 'H' ? dns : ups) if (A.a.idx < B.a.idx && B.b.idx < A.b.idx) tris.push([A, B, null]);
    if (on.triangle)
      for (const [A, B, m] of tris) {
          const [Ut, Dt] = A.a.kind === 'H' ? [A.line, B.line] : [B.line, A.line];
          const su = Ut.b.p - Ut.a.p;
          const sd = Dt.b.p - Dt.a.p;
          if (!(su <= 0 && sd >= 0) || (su === 0 && sd === 0)) continue;
          const t0 = A.a.idx;
          const base = lineAt(Ut, t0) - lineAt(Dt, t0);
          if (base <= 0 || tooSmall(base, A.b.idx) || !closesInside(Ut, Dt, t0, A.b.idx)) continue;
          // The middle point: a pivot of A's kind between B's points, close to A.
          const mid = (m ? [m] : P).find((z) => {
            if (z.kind !== A.a.kind || z.idx <= B.a.idx || z.idx >= B.b.idx) return false;
            const w = lineAt(Ut, z.idx) - lineAt(Dt, z.idx);
            return w > 0 && Math.abs(z.price - lineAt(A.line, z.idx)) <= R.triangle.dev * w;
          });
          if (!mid) continue;
          const flatU = Math.abs(su) <= 0.02 * base;
          const flatD = Math.abs(sd) <= 0.02 * base;
          const type: PatternType = flatU && !flatD ? 'ascendingTriangle' : flatD && !flatU ? 'descendingTriangle' : 'symmetricalTriangle';
          emit(type, [A.a, B.a, mid, B.b, A.b], Ut, Dt, breakOut(Ut, Dt, A.b.idx), type === 'descendingTriangle' ? -1 : 1, base);
        }
  }

  // Settle each candidate, then per kind keep the Awaiting ones first, then the larger (or better
  // fitting) ones, dropping any that overlap a kept one of the same kind.
  const settled = cands.map((x) => {
    const { forming, rank, end, ...rest } = x;
    const p: Pattern = { ...rest, family: FAMILY[x.type], name: PATTERN_NAME[x.type], status: forming ? 'forming' : 'awaiting', statusAt: null };
    return { p: forming ? p : settle(c, p), rank, end };
  });
  const live = (p: Pattern) => p.status === 'awaiting' || p.status === 'forming';
  // The same shape with different starting points (the low the move into it started from): the
  // nearest start is the one TradingView draws.
  const startFirst = new Set<PatternFamily>(['double', 'triple', 'headShoulders', 'flag', 'pennant']);
  const nearest = new Map<string, number>();
  for (const x of settled) {
    if (!startFirst.has(x.p.family)) continue;
    const key = x.p.type + ':' + x.p.points.slice(1).map((q) => q.i).join(',');
    nearest.set(key, Math.max(nearest.get(key) ?? -1, x.p.points[0]!.i));
  }
  for (let i = settled.length - 1; i >= 0; i--) {
    const x = settled[i]!.p;
    if (startFirst.has(x.family) && nearest.get(x.type + ':' + x.points.slice(1).map((q) => q.i).join(',')) !== x.points[0]!.i) settled.splice(i, 1);
  }
  // Per last point, TradingView builds the pattern from the nearest earlier points: of the
  // candidates ending on one pivot, keep the one whose points (from the end back) are latest.
  if (R.nearestLast) {
    const best = new Map<string, (typeof settled)[0]>();
    const later = (a: Pattern, b: Pattern) => {
      for (let k = a.points.length - 1, j = b.points.length - 1; k >= 0 && j >= 0; k--, j--)
        if (a.points[k]!.i !== b.points[j]!.i) return a.points[k]!.i > b.points[j]!.i;
      return false;
    };
    for (const x of settled) {
      if (!R.nearestFamilies.includes(x.p.family)) continue;
      const key = patternKind(x.p.type) + ':' + x.p.points.at(-1)!.i;
      const cur = best.get(key);
      if (!cur || later(x.p, cur.p)) best.set(key, x);
    }
    for (let i = settled.length - 1; i >= 0; i--) {
      const x = settled[i]!;
      if (R.nearestFamilies.includes(x.p.family) && best.get(patternKind(x.p.type) + ':' + x.p.points.at(-1)!.i) !== x) settled.splice(i, 1);
    }
  }
  if (debug) debug.push(...settled.map((x) => x.p));
  settled.sort((x, y) => (R.awaitingFirst ? Number(live(y.p)) - Number(live(x.p)) : 0) || x.rank - y.rank || y.end - x.end);
  const kept = new Map<string, Array<{ start: number; end: number; pts: Set<number> }>>();
  const out: Pattern[] = [];
  for (const { p, end } of settled) {
    const key = patternKind(p.type);
    const list = kept.get(key) ?? [];
    const pts = new Set(p.points.map((q) => q.i));
    // Two patterns of a kind clash when their bars overlap by more than `overlap` of the smaller
    // one, or (overlapPts > 0) when they share that many points.
    const clash = list.some((k) => {
      if (R.overlapPts > 0) return [...pts].filter((i) => k.pts.has(i)).length >= R.overlapPts;
      const ov = Math.min(end, k.end) - Math.max(p.start, k.start);
      return ov >= 0 && ov >= R.overlap * Math.min(end - p.start, k.end - k.start);
    });
    if (clash) continue;
    list.push({ start: p.start, end, pts });
    kept.set(key, list);
    out.push(p);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Where two lines meet (Infinity when they do not converge to the right). */
function apexOf(U: Line, D: Line): number {
  const su = (U.b.p - U.a.p) / (U.b.i - U.a.i);
  const sd = (D.b.p - D.a.p) / (D.b.i - D.a.i);
  if (su >= sd) return Infinity;
  const x0 = Math.max(U.a.i, D.a.i);
  const gap = lineAt(U, x0) - lineAt(D, x0);
  return x0 + gap / (sd - su);
}

/** A line of the mirrored chart back on the real one, from bar `a` to bar `b`. */
function flipLine(l: Line, s: Dir, a: number, b: number): Line {
  return { a: { i: a, p: s * lineAt(l, a) }, b: { i: b, p: s * lineAt(l, b) } };
}

function simpleAtr(c: readonly Candle[], len: number): number[] {
  const out: number[] = [];
  let a = 0;
  for (let i = 0; i < c.length; i++) {
    const x = c[i]!;
    const tr = i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1]!.c), Math.abs(x.l - c[i - 1]!.c));
    a = i === 0 ? tr : a + (tr - a) / Math.min(i + 1, len);
    out.push(a);
  }
  return out;
}

/** Follows the pattern after its breakout: target reached, or back past its invalidation level. */
function settle(c: readonly Candle[], p: Pattern): Pattern {
  for (let k = p.breakout.i + 1; k < c.length; k++) {
    const bar = c[k]!;
    if (p.dir === 1 ? bar.h >= p.target : bar.l <= p.target) return { ...p, status: 'reached', statusAt: k };
    if (p.dir === 1 ? bar.l < p.invalidation : bar.h > p.invalidation) return { ...p, status: 'failed', statusAt: k };
  }
  return p;
}

export type PatternShow = 'all' | 'awaiting' | 'last';

/**
 * Like TradingView's "Patterns" input: every live pattern, only those still awaiting their target
 * (forming ones included), or, of each kind, the awaiting one that starts last.
 */
export function visiblePatterns(list: readonly Pattern[], show: PatternShow): Pattern[] {
  const live = list.filter((p) => p.status === 'awaiting' || p.status === 'reached' || p.status === 'forming');
  if (show === 'all') return live;
  const waiting = live.filter((p) => p.status !== 'reached');
  if (show === 'awaiting') return waiting;
  const latest = new Map<string, Pattern>();
  for (const p of waiting) {
    const k = patternKind(p.type);
    if (!latest.has(k) || p.start > latest.get(k)!.start) latest.set(k, p);
  }
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
