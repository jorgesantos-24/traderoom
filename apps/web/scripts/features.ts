/** Feature table of our candidates of one kind (All mode): matched to TradingView or not. */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '@traderoom/shared';
import { DEFAULT_PATTERNS, findPatterns, type Pattern } from '../src/lib/patterns';
import { loadSnapshots, TV_NAME } from './compare-patterns';

const RES_MIN: Record<string, number> = { '1': 1, '3': 3, '5': 5, '15': 15, '30': 30, '60': 60, '120': 120, '240': 240, '1D': 1440 };
const [dir, name] = process.argv.slice(2);
const PRE = 600;
const rows: string[] = [];
for (const s of loadSnapshots(dir!).filter((x) => x.mode === 'all')) {
  const pair = s.sym.split(':')[1]!;
  const c: Candle[] = JSON.parse(fs.readFileSync(path.join(dir!, 'candles', `${pair}_${s.res}_${s.t0 - PRE * RES_MIN[s.res]!}_${s.t1}.json`), 'utf8'));
  const idx = (min: number) => Math.round((min * 60_000 - c[0]!.t) / (RES_MIN[s.res]! * 60_000));
  const tv = s.out.filter((t) => t.n === name).map((t) => t.p.map((x) => idx(x[0])));
  const all: Pattern[] = [];
  findPatterns(c, DEFAULT_PATTERNS, all);
  // ATR-ish: mean range of 14 bars before the last point.
  const rng = (i: number) => {
    let m = 0;
    for (let k = Math.max(0, i - 14); k < i; k++) m += c[k]!.h - c[k]!.l;
    return m / 14;
  };
  for (const p of all.filter((p) => TV_NAME[p.type] === name && p.breakout.i >= PRE)) {
    const pts = p.points.map((q) => q.i);
    // Matched: TradingView has a pattern sharing the inner points (all but the first).
    const hit = tv.some((t) => pts.slice(1).filter((i) => t.includes(i)).length >= Math.min(3, pts.length - 1));
    const v = p.points.map((q) => q.p);
    const s1 = p.dir === -1 ? 1 : -1;
    const [a0, a1, a2, a3] = v.map((x) => s1 * x) as [number, number, number, number];
    const H = Math.max(a1, a3) - a2;
    rows.push(
      [hit ? 'TV' : '--', pair, s.res, p.status.slice(0, 4), pts.map((i) => i - PRE).join(','),
        `dev ${(Math.abs(a1 - a3) / H).toFixed(2)}`, `trend ${((a1 - a0) / H).toFixed(2)}`, `H/atr ${(H / rng(pts.at(-1)!)).toFixed(1)}`,
        `w ${pts[3]! - pts[1]!}`, `w01 ${pts[1]! - pts[0]!}`, `brk ${p.breakout.i - pts[3]!}`].join(' '),
    );
  }
}
rows.sort();
console.log(rows.join('\n'));
