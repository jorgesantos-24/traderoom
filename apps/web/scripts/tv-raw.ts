/**
 * Raw drawings read off TradingView's "All chart patterns" (Patterns = All) with Claude in Chrome:
 * { sym, res, t0, t1, L: [id, min1, price1, min2, price2, style][], T: [id, min, price, text, tooltip][] }
 * (minutes since epoch). Each pattern's primitives end with its "Target" label, whose tooltip holds
 * "Name\nPrice: x\nStatus: y". The pattern's polyline is its first run of chained solid lines:
 * start, swing points, then the breakout bar (in-progress patterns stop at the last swing point and
 * have no vertical target line).
 */
export type RawSnap = {
  sym: string;
  res: string;
  t0: number;
  t1: number;
  L: Array<[number, number, number, number, number, string]>;
  T: Array<[number, number, number, string, string]>;
};

export type TvPattern = { n: string; st?: string; p: Array<[number, number]>; tg: [number, number] | null; target?: number; lines?: RawSnap['L'] };

/** Points before the breakout, by name. */
const POINTS: Record<string, number> = { Double: 4, Triple: 6, Shoulders: 6, Wedge: 4, Triangle: 5, Flag: 5, Pennant: 5, Rectangle: 4 };

export function rawPatterns(r: RawSnap): TvPattern[] {
  const items = [...r.L.map((l) => ({ id: l[0], l })), ...r.T.map((t) => ({ id: t[0], t }))].sort((a, b) => a.id - b.id);
  const out: TvPattern[] = [];
  let group: typeof items = [];
  for (const it of items) {
    group.push(it);
    const tt = 't' in it ? it.t![4] : '';
    if (!('t' in it) || it.t![3] !== 'Target' || !tt) continue;
    const [name, price, status] = tt.split('\n');
    const lines = group.filter((g) => 'l' in g).map((g) => g.l!);
    group = [];
    // The polyline: the chained run from the first line (dotted parts included).
    const chain: Array<[number, number]> = [];
    for (const l of lines) {
      if (!chain.length) chain.push([l[1], l[2]]);
      else if (chain.at(-1)![0] !== l[1] || l[3] <= l[1]) break;
      chain.push([l[3], l[4]]);
    }
    // The breakout bar: where the vertical dotted line to the target starts.
    // In-progress patterns also get one, at the latest bar.
    const v0 = lines.find((l) => l[5] !== 'sol' && l[1] === l[3] && l[2] !== l[4]);
    const vert = v0 && v0[1] < r.t1 ? v0 : undefined;
    const broken = !!vert;
    const pts = broken ? chain.filter((q) => q[0] < vert[1]) : chain;
    const st = (status ?? '').replace('Status: ', '')[0] ?? 'A';
    // Drawn from before the first loaded bar: clipped there, the points are unknown.
    const clipped = chain.some((q) => q[0] <= r.t0);
    if (broken && (vert[1] < r.t0 || vert[1] > r.t1)) continue;
    // Settled without a breakout line: drawn before the loaded bars.
    if (!broken && st !== 'A' && st !== 'I') continue;
    // Lines that start before the first loaded bar are missing: a short polyline lost its start.
    const want = Object.entries(POINTS).find(([k]) => name!.includes(k))?.[1];
    const short = want !== undefined && pts.length < want;
    out.push({
      n: name!,
      st,
      p: clipped || short ? [] : pts,
      tg: broken ? [vert[1], vert[2]] : [r.t1 + 1e6, 0],
      target: +(price ?? '').replace('Price: ', ''),
      lines,
    });
  }
  return out;
}
