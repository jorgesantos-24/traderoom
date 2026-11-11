/** Triangle candidates: TV-matched vs our kept extras, with shape features. */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '@traderoom/shared';
import { DEFAULT_PATTERNS, findPatterns, lineAt, type Pattern } from '../src/lib/patterns';
import { loadSnapshots, TV_NAME } from './compare-patterns';

const RES_MIN: Record<string, number> = { '1': 1, '3': 3, '5': 5, '15': 15, '30': 30, '60': 60, '120': 120, '240': 240, '1D': 1440 };
const [dir, name = 'Triangle'] = process.argv.slice(2);
const PRE = 600;
const rows: string[] = [];
const mode = process.argv[4] ?? 'kept';
for (const s of loadSnapshots(dir!).filter((x) => x.mode === 'all')) {
  const pair = s.sym.split(':')[1]!;
  const c: Candle[] = JSON.parse(fs.readFileSync(path.join(dir!, 'candles', `${pair}_${s.res}_${s.t0 - PRE * RES_MIN[s.res]!}_${s.t1}.json`), 'utf8'));
  const idx = (min: number) => Math.round((min * 60_000 - c[0]!.t) / (RES_MIN[s.res]! * 60_000));
  const tv = s.out.filter((t) => t.n === name && t.p.length >= 3).map((t) => t.p.map((x) => idx(x[0])));
  const all: Pattern[] = [];
  const kept = findPatterns(c, DEFAULT_PATTERNS, all);
  for (const p of all.filter((p) => TV_NAME[p.type] === name && p.breakout.i >= PRE)) {
    const pts = p.points.map((q) => q.i);
    const exact = tv.some((t) => pts.every((i, j) => t[j] === i));
    if (!exact && (mode === 'tv' || !kept.includes(p))) continue;
    const v = p.points.map((q) => q.p);
    const legs = v.slice(1).map((x, j) => Math.abs(x - v[j]!));
    const gaps = pts.slice(1).map((x, j) => x - pts[j]!);
    const U = p.upper!, D = p.lower!;
    const w0 = lineAt(U, pts[0]!) - lineAt(D, pts[0]!);
    const w4 = lineAt(U, pts.at(-1)!) - lineAt(D, pts.at(-1)!);
    const len = pts.at(-1)! - pts[0]!;
    rows.push([exact ? 'TV' : '--', kept.includes(p) ? 'K' : ' ', pair.padEnd(8), s.res.padStart(3), p.type.slice(0, 4), p.status.slice(0, 4),
      'legs', legs.map((l) => (l / legs[0]!).toFixed(2)).join(','), 'gaps', gaps.map((g) => (g / len).toFixed(2)).join(','),
      'conv', (w4 / w0).toFixed(2), 'tvSt', '', 'len', len, 'brk', p.breakout.i - pts.at(-1)!].join(' '));
  }
}
console.log(rows.sort().join('\n'));
