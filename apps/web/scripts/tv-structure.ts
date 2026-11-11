/** For each TradingView pattern (All mode): kind of pivot at each point (H/L/-), and whether the legs are clean price lines. */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '@traderoom/shared';
import { pivots } from '../src/lib/patterns';
import { loadSnapshots } from './compare-patterns';

const RES_MIN: Record<string, number> = { '1': 1, '3': 3, '5': 5, '15': 15, '30': 30, '60': 60, '120': 120, '240': 240, '1D': 1440 };
const [dir, name] = process.argv.slice(2);
const PRE = 600;
for (const s of loadSnapshots(dir!).filter((x) => x.mode === 'all')) {
  const pair = s.sym.split(':')[1]!;
  const c: Candle[] = JSON.parse(fs.readFileSync(path.join(dir!, 'candles', `${pair}_${s.res}_${s.t0 - PRE * RES_MIN[s.res]!}_${s.t1}.json`), 'utf8'));
  const idx = (min: number) => Math.round((min * 60_000 - c[0]!.t) / (RES_MIN[s.res]! * 60_000));
  const P = pivots(c, 5);
  for (const t of s.out.filter((t) => !name || t.n === name)) {
    const pts = t.p.map((x) => idx(x[0])).filter((i) => i < c.length && i >= 0);
    if (pts.length < 3) continue;
    const kinds = pts.map((i) => P.filter((z) => z.idx === i).map((z) => z.kind).join('') || '-');
    // leg check: from H, the next L is the min of the bars between; etc.
    const legs = pts.slice(1).map((b, j) => {
      const a = pts[j]!;
      let mx = -Infinity, mn = Infinity, imx = 0, imn = 0;
      for (let k = a; k <= b; k++) { if (c[k]!.h > mx) { mx = c[k]!.h; imx = k; } if (c[k]!.l < mn) { mn = c[k]!.l; imn = k; } }
      return (imx === a && imn === b) || (imn === a && imx === b) ? '=' : '~';
    });
    const prices = pts.map((i, j) => (kinds[j]!.startsWith('H') ? c[i]!.h : c[i]!.l));
    console.log(`${pair} ${s.res.padStart(3)} ${t.n.padEnd(14)} ${t.st} ${kinds.join(' ').padEnd(16)} legs ${legs.join('')}  n=${pts.length} gaps ${pts.slice(1).map((b, j) => b - pts[j]!).join(',')} brk+${idx(t.tg![0]) - pts.at(-1)!} ${prices.map(p=>p.toPrecision(6)).join(' ')}`);
  }
}
