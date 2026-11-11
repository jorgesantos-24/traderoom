/** For TradingView patterns we generate but drop: which kept candidate (same kind) beat them. */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '@traderoom/shared';
import { DEFAULT_PATTERNS, findPatterns, patternKind, type Pattern } from '../src/lib/patterns';
import { loadSnapshots, TV_NAME } from './compare-patterns';

const RES_MIN: Record<string, number> = { '1': 1, '3': 3, '5': 5, '15': 15, '30': 30, '60': 60, '120': 120, '240': 240, '1D': 1440 };
const [dir, name] = process.argv.slice(2);
const PRE = 600;
const f = (p: Pattern) => `${p.status.slice(0, 4)} ${p.points.map((q) => q.i - PRE).join(',')}>${p.breakout.i - PRE}`;
for (const s of loadSnapshots(dir!).filter((x) => x.mode === 'all')) {
  const pair = s.sym.split(':')[1]!;
  const c: Candle[] = JSON.parse(fs.readFileSync(path.join(dir!, 'candles', `${pair}_${s.res}_${s.t0 - PRE * RES_MIN[s.res]!}_${s.t1}.json`), 'utf8'));
  const idx = (min: number) => Math.round((min * 60_000 - c[0]!.t) / (RES_MIN[s.res]! * 60_000));
  const tv = s.out.filter((t) => t.n === name && t.p.length >= 3).map((t) => t.p.map((x) => idx(x[0])));
  const all: Pattern[] = [];
  const kept = findPatterns(c, DEFAULT_PATTERNS, all);
  const isTv = (p: Pattern) => { const pts = p.points.map((q) => q.i); return tv.some((t) => pts.filter((i) => t.includes(i)).length >= pts.length - 1); };
  for (const p of all.filter((p) => TV_NAME[p.type] === name && !kept.includes(p) && isTv(p))) {
    const ks = kept.filter((k) => patternKind(k.type) === patternKind(p.type) && Math.min(k.breakout.i, p.breakout.i) >= Math.max(k.start, p.start));
    console.log(`${pair} ${s.res} TV ${f(p)}  <- ${ks.map((k) => (isTv(k) ? '[tv]' : '') + f(k)).join(' | ')}`);
  }
}
