/** For TradingView wedges/triangles with known points: which of our conditions rejects them. */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '@traderoom/shared';
import { pivots, lineAt, RULES, type Line } from '../src/lib/patterns';
import { loadSnapshots, RES_MIN } from './compare-patterns';

const [dir, name = 'Wedge'] = process.argv.slice(2);
const PRE = 600;
for (const s of loadSnapshots(dir!).filter((x) => x.mode === 'all')) {
  const pair = s.sym.split(':')[1]!;
  const f = fs.readdirSync(path.join(dir!, 'candles')).find((x) => x.startsWith(`${pair}_${s.res}_${s.t0 - PRE * RES_MIN[s.res]!}_`))!;
  const c: Candle[] = JSON.parse(fs.readFileSync(path.join(dir!, 'candles', f), 'utf8'));
  const idx = (min: number) => Math.round((min * 60_000 - c[0]!.t) / (RES_MIN[s.res]! * 60_000));
  const P = pivots(c, 5);
  for (const t of s.out.filter((t) => t.n.includes(name) && t.p.length >= 4)) {
    const pts = t.p.map((x) => idx(x[0]));
    const brk = idx(t.tg![0]);
    const why: string[] = [];
    const kinds = pts.map((i) => P.filter((z) => z.idx === i).map((z) => z.kind).join('') || '-');
    if (kinds.some((k) => k === '-')) why.push('notPivot ' + kinds.join(''));
    // price at TV point vs candle
    if (pts.some((i) => !c[i])) continue;
    const pr = t.p.map((x, j) => `${x[1]}/${c[pts[j]!]!.h}/${c[pts[j]!]!.l}`);
    // legs clean?
    for (let j = 1; j < pts.length; j++) {
      const a = pts[j - 1]!, b = pts[j]!;
      let mx = -Infinity, mn = Infinity;
      for (let k = a + 1; k < b; k++) { mx = Math.max(mx, c[k]!.h); mn = Math.min(mn, c[k]!.l); }
      const up = t.p[j]![1] > t.p[j - 1]![1];
      if (up ? mn < t.p[j - 1]![1] || mx > t.p[j]![1] : mx > t.p[j - 1]![1] || mn < t.p[j]![1])
        why.push(`leg${j - 1}${j}dirty(${up ? (mn < t.p[j - 1]![1] ? 'startBeaten ' : '') + (mx > t.p[j]![1] ? 'endBeaten' : '') : (mx > t.p[j - 1]![1] ? 'startBeaten ' : '') + (mn < t.p[j]![1] ? 'endBeaten' : '')})`);
    }
    const hi = t.p.filter((_, j) => j % 2 === (t.p[0]![1] > t.p[1]![1] ? 0 : 1));
    const n = pts.length;
    const tri = n === 5;
    const P0 = t.p[0]!, P1 = t.p[1]!, P3 = t.p[3]!, P4 = t.p[4] ?? t.p[3]!;
    const L1: Line = { a: { i: pts[0]!, p: P0[1] }, b: { i: pts[4] ?? pts[2]!, p: tri ? P4[1] : t.p[2]![1] } };
    const L2: Line = { a: { i: pts[1]!, p: P1[1] }, b: { i: pts[3]!, p: P3[1] } };
    const U0: Line = t.p[0]![1] > t.p[1]![1] ? { a: { i: pts[0]!, p: t.p[0]![1] }, b: { i: pts[2]!, p: t.p[2]![1] } } : { a: { i: pts[1]!, p: t.p[1]![1] }, b: { i: pts[3]!, p: t.p[3]![1] } };
    const D0: Line = t.p[0]![1] > t.p[1]![1] ? { a: { i: pts[1]!, p: t.p[1]![1] }, b: { i: pts[3]!, p: t.p[3]![1] } } : { a: { i: pts[0]!, p: t.p[0]![1] }, b: { i: pts[2]!, p: t.p[2]![1] } };
    const U = tri ? (P0[1] > P1[1] ? L1 : L2) : U0;
    const D = tri ? (P0[1] > P1[1] ? L2 : L1) : D0;
    if (tri) {
      const w = lineAt(U, pts[2]!) - lineAt(D, pts[2]!);
      const dev = Math.abs(t.p[2]![1] - lineAt(L1, pts[2]!)) / w;
      if (dev > RULES.triangle.dev) why.push(`middev ${dev.toFixed(3)}`);
      const v = t.p.map((x) => x[1]);
      const legs = v.slice(1).map((x, j) => Math.abs(x - v[j]!));
      if (legs.some((l, j) => j > 0 && l > legs[j - 1]!)) why.push('notMono ' + legs.map((l) => (l / legs[0]!).toFixed(2)).join(','));
      if (legs[3]! < RULES.triangle.minLast * legs[0]!) why.push('lastSmall');
      const su = U.b.p - U.a.p, sd = D.b.p - D.a.p;
      if (!(su <= 0 && sd >= 0)) why.push(`slopes ${su > 0 ? 'U+' : ''}${sd < 0 ? 'D-' : ''}`);
    }
    let out = 0;
    for (let k = pts[0]!; k <= pts[n - 1]!; k++) if (c[k]!.c > lineAt(U, k) + 1e-12 || c[k]!.c < lineAt(D, k) - 1e-12) out++;
    if (out) why.push(`closesOut${out}`);
    const w0 = lineAt(U, pts[0]!) - lineAt(D, pts[0]!), w3 = lineAt(U, pts[3]!) - lineAt(D, pts[3]!);
    if (n === 4 && !(w3 <= (1 - RULES.wedge.ratio) * w0)) why.push(`ratio ${(w3 / w0).toFixed(2)}`);
    let b2 = -1;
    for (let k = pts[n - 1]! + 1; k < c.length; k++) if (c[k]!.c > lineAt(U, k) || c[k]!.c < lineAt(D, k)) { b2 = k; break; }
    if (b2 !== brk && !(b2 === -1 && brk >= c.length - 1)) why.push(`brk ours ${b2 - PRE} tv ${brk - PRE}`);
    console.log(`${pair} ${s.res} ${t.n} ${t.st} ${pts.map((i) => i - PRE).join(',')}>${brk - PRE}: ${why.join(' ') || 'OK'}  ${hi.length ? '' : pr.join(' ')}`);
  }
}
