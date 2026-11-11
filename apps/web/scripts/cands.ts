/** Lists our candidates of one kind on one All-mode snapshot (offsets from TradingView's first bar). */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '@traderoom/shared';
import { DEFAULT_PATTERNS, findPatterns, type Pattern } from '../src/lib/patterns';
import { loadSnapshots, TV_NAME } from './compare-patterns';

const RES_MIN: Record<string, number> = { '1': 1, '3': 3, '5': 5, '15': 15, '30': 30, '60': 60, '120': 120, '240': 240, '1D': 1440 };
const [dir, pair, res, name, from = '-999', to = '999'] = process.argv.slice(2);
const PRE = 600;
const s = loadSnapshots(dir!).find((x) => x.mode === 'all' && x.sym.endsWith(':' + pair) && x.res === res)!;
const c: Candle[] = JSON.parse(fs.readFileSync(path.join(dir!, 'candles', `${pair}_${res}_${s.t0 - PRE * RES_MIN[res!]!}_${s.t1}.json`), 'utf8'));
const idx = (min: number) => Math.round((min * 60_000 - c[0]!.t) / (RES_MIN[res!]! * 60_000)) - PRE;
console.log('TV:', s.out.filter((t) => t.n === name).map((t) => `${t.st} ${t.p.map((x) => idx(x[0])).join(',')}>${idx(t.tg![0])}`).join(' | '));
const all: Pattern[] = [];
const kept = findPatterns(c, DEFAULT_PATTERNS, all);
for (const p of all.filter((p) => TV_NAME[p.type] === name && p.breakout.i - PRE >= +from && p.start - PRE <= +to))
  console.log(`${kept.includes(p) ? 'KEPT' : '    '} ${p.status.padEnd(8)} ${p.points.map((q) => q.i - PRE).join(',')}>${p.breakout.i - PRE}`);
