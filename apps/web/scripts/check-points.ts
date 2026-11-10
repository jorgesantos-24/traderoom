/** Checks given points (offsets from TradingView's first bar) on one snapshot: pivots and price-line legs. */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '@traderoom/shared';
import { pivots } from '../src/lib/patterns';

const RES_MIN: Record<string, number> = { '1': 1, '3': 3, '5': 5, '15': 15, '30': 30, '60': 60, '240': 240, '1D': 1440 };
const [dir, pair, res, t0, ...offs] = process.argv.slice(2);
const PRE = 600;
const f = fs.readdirSync(path.join(dir!, 'candles')).find((x) => x.startsWith(`${pair}_${res}_${+t0! - PRE * RES_MIN[res!]!}_`))!;
const c: Candle[] = JSON.parse(fs.readFileSync(path.join(dir!, 'candles', f), 'utf8'));
const P = pivots(c, 5);
const pts = offs.map((o) => +o + PRE);
for (const i of pts) {
  const k = P.filter((z) => z.idx === i).map((z) => z.kind).join('');
  const near = P.filter((z) => Math.abs(z.idx - i) <= 3 && z.idx !== i).map((z) => `${z.kind}@${z.idx - PRE}`);
  console.log(`${i - PRE}: pivot ${k || '-'} h ${c[i]!.h} l ${c[i]!.l} c ${c[i]!.c}  near ${near.join(' ')}`);
}
for (let j = 1; j < pts.length; j++) {
  const a = pts[j - 1]!;
  const b = pts[j]!;
  let mx = -Infinity, mn = Infinity, imx = 0, imn = 0;
  for (let k = a; k <= b; k++) {
    if (c[k]!.h > mx) { mx = c[k]!.h; imx = k; }
    if (c[k]!.l < mn) { mn = c[k]!.l; imn = k; }
  }
  console.log(`leg ${a - PRE}->${b - PRE}: max ${mx}@${imx - PRE} min ${mn}@${imn - PRE}`);
}
const last = pts.at(-1)!;
console.log('after last:', c.slice(last + 1, last + 30).map((x, k) => `${last + 1 + k - PRE}:${x.l}/${x.h}/${x.c}`).join(' '));
