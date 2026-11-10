/** Prints each TradingView pattern's points with their pivot kind, to see how TradingView picks its points. */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '@traderoom/shared';
import { pivots } from '../src/lib/patterns';
import { loadSnapshots } from './compare-patterns';

const RES_MIN: Record<string, number> = { '1': 1, '3': 3, '5': 5, '15': 15, '30': 30, '60': 60, '240': 240, '1D': 1440 };
const dir = process.argv[2]!;
const only = process.argv[3];
const PRE = 600;
for (const s of loadSnapshots(dir)) {
  const pair = s.sym.split(':')[1]!;
  const f = path.join(dir, 'candles', `${pair}_${s.res}_${s.t0 - PRE * RES_MIN[s.res]!}_${s.t1}.json`);
  if (!fs.existsSync(f)) continue;
  const c: Candle[] = JSON.parse(fs.readFileSync(f, 'utf8'));
  const P = pivots(c, 5);
  const kind = new Map<number, string>();
  for (const z of P) kind.set(z.idx, (kind.get(z.idx) ?? '') + z.kind);
  const idx = (min: number) => Math.round((min * 60_000 - c[0]!.t) / (RES_MIN[s.res]! * 60_000));
  for (const t of s.out) {
    if (only && !t.n.includes(only)) continue;
    const pts = t.p.map((x) => idx(x[0]));
    const b = idx(t.tg![0]);
    const desc = pts.map((i) => {
      const k = kind.get(i) ?? '-';
      const x = c[i];
      const v = !x ? '?' : k.includes('H') ? x.h : k.includes('L') ? x.l : `c${x.c}`;
      return `${i - PRE}${k}(${v})`;
    });
    console.log(`${pair} ${s.res} ${t.n.padEnd(22)} brk ${b - PRE}${c[b] ? '' : '(future)'}  ${desc.join(' ')}`);
  }
}
