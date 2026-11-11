/** TradingView wedges matched on the last 3 points: which start TradingView took among our alternatives. */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '@traderoom/shared';
import { DEFAULT_PATTERNS, findPatterns, lineAt, type Pattern } from '../src/lib/patterns';
import { loadSnapshots, RES_MIN, TV_NAME } from './compare-patterns';

const [dir, name = 'Wedge'] = process.argv.slice(2);
const PRE = 600;
for (const s of loadSnapshots(dir!).filter((x) => x.mode === 'all')) {
  const pair = s.sym.split(':')[1]!;
  const f = fs.readdirSync(path.join(dir!, 'candles')).find((x) => x.startsWith(`${pair}_${s.res}_${s.t0 - PRE * RES_MIN[s.res]!}_`))!;
  const c: Candle[] = JSON.parse(fs.readFileSync(path.join(dir!, 'candles', f), 'utf8'));
  const idx = (min: number) => Math.round((min * 60_000 - c[0]!.t) / (RES_MIN[s.res]! * 60_000));
  const all: Pattern[] = [];
  findPatterns(c, DEFAULT_PATTERNS, all);
  for (const t of s.out.filter((t) => t.n.includes(name) && t.p.length >= 4)) {
    const pts = t.p.map((x) => idx(x[0]));
    const alts = all.filter((p) => TV_NAME[p.type] === t.n && p.points.length === pts.length && p.points.slice(1).every((q, j) => q.i === pts[j + 1]));
    if (alts.length < 2) continue;
    const desc = alts
      .sort((a, b) => a.start - b.start)
      .map((p) => {
        const U = p.upper!, D = p.lower!;
        const w0 = lineAt(U, p.start) - lineAt(D, p.start), w3 = lineAt(U, p.points[3]!.i) - lineAt(D, p.points[3]!.i);
        return `${p.start === pts[0] ? '*' : ' '}${p.start - PRE}@${p.points[0]!.p} r${(w3 / w0).toFixed(2)}`;
      });
    console.log(`${pair} ${s.res} ${t.n} tv ${pts[0]! - PRE}: ${desc.join(' | ')}`);
  }
}
