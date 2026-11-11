/** Pivots (5/5) of one new-data snapshot between two offsets from TradingView's first bar. */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '@traderoom/shared';
import { pivots } from '../src/lib/patterns';
import { loadSnapshots, RES_MIN } from './compare-patterns';
const [dir, pair, res, a, b] = process.argv.slice(2);
const PRE = 600;
const s = loadSnapshots(dir!).find((x) => x.sym.endsWith(':' + pair) && x.res === res)!;
const f = fs.readdirSync(path.join(dir!, 'candles')).find((x) => x.startsWith(`${pair}_${res}_${s.t0 - PRE * RES_MIN[res!]!}_`))!;
const c: Candle[] = JSON.parse(fs.readFileSync(path.join(dir!, 'candles', f), 'utf8'));
console.log(pivots(c, 5).filter((z) => z.idx - PRE >= +a! && z.idx - PRE <= +b!).map((z) => `${z.idx - PRE}${z.kind}${z.price}`).join(' '));
