import fs from 'node:fs';
import { rawPatterns, type RawSnap } from './tv-raw';
const a: RawSnap[] = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8'));
let n = 0;
const by: Record<string, number> = {};
const st: Record<string, number> = {};
for (const r of a) for (const p of rawPatterns(r)) { n++; by[p.n] = (by[p.n] ?? 0) + 1; st[p.st!] = (st[p.st!] ?? 0) + 1; }
console.log(a.length, n, by, st);
const [pair, res] = (process.argv[3] ?? 'ETHUSDT 15').split(' ');
const r = a.find((x) => x.sym.endsWith(pair!) && x.res === res)!;
const R = ({ "1": 1, "3": 3, "5": 5, "15": 15, "30": 30, "60": 60, "120": 120, "240": 240, "1D": 1440 } as Record<string, number>)[res!]!;
for (const p of rawPatterns(r)) console.log(p.n, p.st, p.p.map((q) => Math.round((q[0] - r.t0) / R) + '@' + q[1]).join(' '), 'brk', Math.round((p.tg![0] - r.t0) / R));
