/** Our candidates of one TradingView name (All mode) with features; TV = TradingView drew the same points. */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '@traderoom/shared';
import { DEFAULT_PATTERNS, findPatterns, type Pattern } from '../src/lib/patterns';
import { loadSnapshots, TV_NAME } from './compare-patterns';

const RES_MIN: Record<string, number> = { '1': 1, '3': 3, '5': 5, '15': 15, '30': 30, '60': 60, '120': 120, '240': 240, '1D': 1440 };
const [dir, name] = process.argv.slice(2);
const PRE = 600;
for (const s of loadSnapshots(dir!).filter((x) => x.mode === 'all')) {
  const pair = s.sym.split(':')[1]!;
  const c: Candle[] = JSON.parse(fs.readFileSync(path.join(dir!, 'candles', `${pair}_${s.res}_${s.t0 - PRE * RES_MIN[s.res]!}_${s.t1}.json`), 'utf8'));
  const idx = (min: number) => Math.round((min * 60_000 - c[0]!.t) / (RES_MIN[s.res]! * 60_000));
  const tv = s.out.filter((t) => t.n === name && t.p.length >= 3).map((t) => t.p.map((x) => idx(x[0])));
  const all: Pattern[] = [];
  const kept = findPatterns(c, DEFAULT_PATTERNS, all);
  const cand = all.filter((p) => TV_NAME[p.type] === name && p.breakout.i >= PRE);
  for (const p of cand) {
    const pts = p.points.map((q) => q.i);
    const share = Math.max(0, ...tv.map((t) => pts.filter((i) => t.includes(i)).length));
    const hit = share >= pts.length - 1 ? 'TV' : share >= 3 ? 'tv' : '--';
    if (hit === '--' && !kept.includes(p)) continue;
    console.log(`${hit} ${kept.includes(p) ? 'K' : ' '} ${pair.padEnd(8)} ${s.res.padStart(3)} ${p.type.padEnd(20)} ${p.status.slice(0, 4)} pts ${pts.map((i) => i - PRE).join(',')} >${p.breakout.i - PRE} len ${pts.at(-1)! - pts[0]!}`);
  }
}
