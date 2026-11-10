/** For each TradingView pattern: is it among our candidates (same points), and what did we pick instead? */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '@traderoom/shared';
import { DEFAULT_PATTERNS, findPatterns, visiblePatterns, type Pattern } from '../src/lib/patterns';
import { loadSnapshots, TV_NAME } from './compare-patterns';

const RES_MIN: Record<string, number> = { '1': 1, '3': 3, '5': 5, '15': 15, '30': 30, '60': 60, '240': 240, '1D': 1440 };
const dir = process.argv[2]!;
const only = process.argv[3];
const PRE = 600;
const stats = { exact: 0, near: 0, none: 0, shown: 0 };
const mode = process.argv[4] ?? 'all';
for (const s of loadSnapshots(dir).filter((x) => x.mode === mode)) {
  const pair = s.sym.split(':')[1]!;
  const f = path.join(dir, 'candles', `${pair}_${s.res}_${s.t0 - PRE * RES_MIN[s.res]!}_${s.t1}.json`);
  const c: Candle[] = JSON.parse(fs.readFileSync(f, 'utf8'));
  const idx = (min: number) => Math.round((min * 60_000 - c[0]!.t) / (RES_MIN[s.res]! * 60_000));
  const all: Pattern[] = [];
  const kept = findPatterns(c, DEFAULT_PATTERNS, all);
  const shown = mode === 'all' ? kept : visiblePatterns(kept, 'last');
  for (const t of s.out) {
    if (!t.n || (only && !t.n.includes(only))) continue;
    const pts = t.p.map((x) => idx(x[0])).filter((i) => i < c.length);
    const brk = idx(t.tg![0]);
    const same = all.filter((p) => TV_NAME[p.type] === t.n);
    const has = (p: Pattern) => pts.filter((i) => p.points.some((q) => q.i === i)).length;
    const best = same.sort((a, b) => has(b) - has(a))[0];
    const k = best ? has(best) : 0;
    const tag = best && k >= Math.min(4, pts.length) && pts.length > 0 ? 'exact' : best && k >= 2 ? 'near' : 'none';
    stats[tag]++;
    const isShown = best && shown.includes(best);
    if (isShown) stats.shown++;
    const sh = shown.find((p) => TV_NAME[p.type] === t.n);
    const f2 = (p?: Pattern) => (p ? `${p.points.map((q) => q.i - PRE).join(',')}>${p.breakout.i - PRE} ${p.status}` : '-');
    console.log(`${pair} ${s.res} ${t.n.padEnd(20)} ${t.st} tv ${pts.map((i) => i - PRE).join(',')}>${brk - PRE}  ${tag} ${k}/${pts.length} best ${f2(best)} ${isShown ? 'SHOWN' : `| shown ${f2(sh)}`}`);
  }
}
console.log(stats);
