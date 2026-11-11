/**
 * Compares our chart-pattern detector with TradingView's "All chart patterns" (Patterns = Last Awaiting).
 *
 * Input: a folder of TradingView snapshots, one JSON per symbol and timeframe:
 *   { sym: 'BINANCE:BTCUSDT', res: '5', t0, t1, out: [{ n: label text, p: [[minute, price]...], tg: [minute, price] }] }
 * (t0/t1 = first and last bar TradingView had loaded, in epoch minutes). The candles are fetched from
 * Binance, identical to TradingView's BINANCE symbols, cached next to the snapshots.
 *
 *   npx tsx apps/web/scripts/compare-patterns.ts <folder> [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '@traderoom/shared';
import { rawPatterns, type RawSnap } from './tv-raw';
import { PREFER, RULES, DEFAULT_PATTERNS, findPatterns, visiblePatterns, type Pattern, type PatternType } from '../src/lib/patterns';

type TvPattern = { n: string; st?: string; p: Array<[number, number]>; tg: [number, number] | null };
type Snapshot = { sym: string; res: string; t0: number; t1: number; out: TvPattern[]; mode?: 'last' | 'all' };

export const RES_MIN: Record<string, number> = { '1': 1, '3': 3, '5': 5, '15': 15, '30': 30, '60': 60, '120': 120, '240': 240, '1D': 1440 };
const BINANCE_INT: Record<string, string> = { '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m', '60': '1h', '120': '2h', '240': '4h', '1D': '1d' };

/** Our types under TradingView's names (TradingView has one "Triangle"). */
export const TV_NAME: Record<PatternType, string> = {
  doubleTop: 'Double Top',
  doubleBottom: 'Double Bottom',
  tripleTop: 'Triple Top',
  tripleBottom: 'Triple Bottom',
  headShoulders: 'Head and Shoulders',
  inverseHeadShoulders: 'Inverted Head and Shoulders',
  risingWedge: 'Rising Wedge',
  fallingWedge: 'Falling Wedge',
  ascendingTriangle: 'Triangle',
  descendingTriangle: 'Triangle',
  symmetricalTriangle: 'Triangle',
  rectangle: 'Rectangle',
  bullFlag: 'Bullish Flag',
  bearFlag: 'Bearish Flag',
  bullPennant: 'Bullish Pennant',
  bearPennant: 'Bearish Pennant',
  cupHandle: 'Cup and Handle',
  invertedCupHandle: 'Inverted Cup and Handle',
};

/** TradingView's label text -> pattern name. Head and shoulders are labelled per point. */
function tvName(t: TvPattern): string {
  const n = t.n;
  if (Object.values(TV_NAME).includes(n)) return n;
  if (/Shoulder|Head/.test(n)) {
    const ps = t.p.map((x) => x[1]);
    // Point order: start, LS, n1, head, n2, RS. The head is the extreme of the swing points.
    const mid = ps.slice(1);
    const max = Math.max(...mid);
    const min = Math.min(...mid);
    const head = ps[3] ?? ps[Math.floor(ps.length / 2)]!;
    return Math.abs(head - max) < Math.abs(head - min) ? 'Head and Shoulders' : 'Inverted Head and Shoulders';
  }
  if (/Top|Bottom/.test(n)) {
    // "Top"/"Bottom" labels per point: count them.
    const parts = n.split('/');
    const tops = parts.filter((x) => /Top/.test(x)).length;
    const bottoms = parts.filter((x) => /Bottom/.test(x)).length;
    if (/^(Double|Triple) (Top|Bottom)$/.test(parts[0]!)) return parts[0]!;
    const k = Math.max(tops, bottoms);
    return `${k >= 3 ? 'Triple' : 'Double'} ${tops >= bottoms ? 'Top' : 'Bottom'}`;
  }
  return n.split('/')[0] ?? '';
}

/** Bars before TradingView's first loaded one: its study runs on the server with more history. */
const PRE = Number(process.argv.find((a) => a.startsWith('--pre='))?.slice(6) ?? 600);

async function candlesFor(dir: string, s: Snapshot): Promise<Candle[]> {
  const pair = s.sym.split(':')[1]!;
  const cache = path.join(dir, 'candles', `${pair}_${s.res}_${s.t0 - PRE * RES_MIN[s.res]!}_${s.t1}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const step = RES_MIN[s.res]! * 60_000;
  const out: Candle[] = [];
  let from = (s.t0 - PRE * RES_MIN[s.res]!) * 60_000;
  const to = s.t1 * 60_000;
  while (from <= to) {
    const u = `https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=${BINANCE_INT[s.res]}&startTime=${from}&endTime=${to}&limit=1000`;
    const k = (await (await fetch(u)).json()) as Array<[number, string, string, string, string, string]>;
    if (!k.length) break;
    for (const r of k) out.push({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });
    from = k.at(-1)![0] + step;
  }
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(out));
  return out;
}

export interface Score {
  found: number;
  missed: number;
  extra: number;
  /** Matched patterns whose status agrees. */
  sameStatus: number;
  lines: string[];
}

const statusOf = (p: Pattern) => (p.status === 'reached' ? 'R' : p.status === 'failed' ? 'F' : 'A');

/** Ours vs TradingView on one snapshot. A match: same name, breakout within `tol` bars, start within a quarter of the span. */
export function score(c: Candle[], s: Snapshot, ours: Pattern[]): Score {
  const step = RES_MIN[s.res]!;
  const idx = (min: number) => Math.round((min * 60_000 - c[0]!.t) / (step * 60_000));
  const fmt = (i: number) => (c[i] ? new Date(c[i]!.t - 3 * 3600_000).toISOString().slice(5, 16).replace('T', ' ') : `#${i}`);
  const lastBar = c.length - 1;
  const tv = s.out
    .filter((t) => t.n && t.tg)
    .map((t) => {
      const brk = idx(t.tg![0]);
      const pts = t.p.map((x) => idx(x[0])).filter((i) => i <= lastBar);
      // In-progress patterns are drawn dotted (not read): only the name and "no breakout yet" are known.
      return { name: tvName(t), st: t.st ?? 'A', start: pts[0] ?? null, brk, forming: brk > lastBar, pts };
    });
  // TradingView only draws what reaches its first loaded bar.
  const first = idx(s.t0);
  const mine = ours.filter((p) => p.breakout.i >= first).map((p) => ({ name: TV_NAME[p.type], start: p.start, brk: p.breakout.i, p }));
  const used = new Set<number>();
  const lines: string[] = [];
  let found = 0;
  let sameStatus = 0;
  for (const t of tv) {
    let best = -1;
    let bestD = Infinity;
    mine.forEach((m, k) => {
      if (used.has(k) || m.name !== t.name) return;
      let d: number;
      if (t.forming) {
        if (m.p.status !== 'forming') return;
        d = t.start === null ? 0 : Math.abs(m.start - t.start);
      } else {
        const span = Math.max(10, t.brk - (t.start ?? t.brk));
        if (Math.abs(m.brk - t.brk) > Math.max(3, span / 6) || (t.start !== null && Math.abs(m.start - t.start) > span / 2)) return;
        d = Math.abs(m.brk - t.brk) + (t.start === null ? 0 : Math.abs(m.start - t.start) / 4);
      }
      if (d < bestD) {
        best = k;
        bestD = d;
      }
    });
    const tvAt = `${t.start === null ? '?' : fmt(t.start)}..${t.forming ? 'forming' : fmt(t.brk)} ${t.st}`;
    if (best >= 0) {
      used.add(best);
      found++;
      const m = mine[best]!;
      if (statusOf(m.p) === t.st) sameStatus++;
      lines.push(`  ok    ${t.name.padEnd(28)} tv ${tvAt}  ours ${fmt(m.start)}..${fmt(m.brk)} ${statusOf(m.p)}`);
    } else lines.push(`  MISS  ${t.name.padEnd(28)} tv ${tvAt}  pts ${t.pts.map(fmt).join(', ')}`);
  }
  mine.forEach((m, k) => {
    if (!used.has(k)) lines.push(`  EXTRA ${m.name.padEnd(28)} ours ${fmt(m.start)}..${fmt(m.brk)} ${m.p.status} pts ${m.p.points.map((q) => fmt(q.i)).join(', ')}`);
  });
  return { found, missed: tv.length - found, extra: mine.length - used.size, sameStatus, lines };
}

const CODE: Record<string, string> = Object.fromEntries(
  [...new Set(Object.values(TV_NAME))].map((n) => [n.split(' ').map((w) => w.slice(0, 2)).join(''), n]),
);

/**
 * Snapshot lines as read off TradingView: "BTCUSDT 5 <t0> <t1>|RiWe:A:34,250:263;Tr:A:34,116:132"
 * (name code : status initial : swing points as bar offsets from t0 : breakout offset).
 */
export function parseSnapshots(text: string): Snapshot[] {
  return text
    .split(/\r?\n/)
    .filter((l) => /^\w+ \w+ \d+ \d+\|/.test(l))
    .map((l) => {
      const [head, body = ''] = l.split('|');
      const [pair, res, t0, t1] = head!.split(' ');
      const R = RES_MIN[res!]!;
      const at = (o: string) => +t0! + +o * R;
      const out = body
        .split(';')
        .filter(Boolean)
        .map((p) => {
          const [code, st, pts, tg] = p.split(':');
          return {
            n: CODE[code!] ?? code!,
            st: st || 'A',
            p: (pts ? pts.split(',') : [tg!]).map((o) => [at(o), 0] as [number, number]),
            tg: [at(tg!), 0] as [number, number],
          };
        });
      return { sym: `BINANCE:${pair}`, res: res!, t0: +t0!, t1: +t1!, out };
    });
}

export function loadSnapshots(dir: string): Snapshot[] {
  const files = fs.readdirSync(dir);
  return [
    ...files
      .filter((f) => f.endsWith('.raw.json'))
      .flatMap((f) => (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as RawSnap[]).map((r) => ({ sym: r.sym, res: r.res, t0: r.t0, t1: r.t1, out: rawPatterns(r), mode: 'all' as const }))),
    ...files.filter((f) => f.endsWith('.json') && !f.endsWith('.raw.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Snapshot),
    ...files
      .filter((f) => f.endsWith('.txt'))
      .flatMap((f) => parseSnapshots(fs.readFileSync(path.join(dir, f), 'utf8')).map((x) => ({ ...x, mode: f.includes('-all') ? ('all' as const) : ('last' as const) }))),
  ].filter((s) => s.sym?.startsWith('BINANCE:') && RES_MIN[s.res]);
}

async function main() {
  const dir = process.argv[2]!;
  // --set=wedge.ratio=0.3 --set=prefer.wedge=1: try other rule values.
  for (const a of process.argv.filter((x) => x.startsWith('--set='))) {
    const [k, val] = a.slice(6).split('=');
    const path = k!.split('.');
    const root: Record<string, unknown> = path[0] === 'prefer' ? (PREFER as Record<string, unknown>) : (RULES as unknown as Record<string, unknown>);
    const keys = path[0] === 'prefer' ? path.slice(1) : path;
    let o = root;
    for (const p of keys.slice(0, -1)) o = o[p] as Record<string, unknown>;
    o[keys.at(-1)!] = val === 'true' ? true : val === 'false' ? false : val!.includes(',') || /^[a-z]/i.test(val!) ? (val ? val.split(',').filter(Boolean) : []) : Number(val);
  }
  const verbose = process.argv.includes('--verbose');
  const quiet = process.argv.includes('--quiet');
  const modeArg = process.argv.find((a) => a.startsWith('--mode='))?.slice(7);
  const snaps = loadSnapshots(dir).filter((s) => !modeArg || s.mode === modeArg);
  const tot: Record<string, { F: number; M: number; E: number; S: number }> = {};
  const byName = new Map<string, { f: number; m: number; e: number }>();
  for (const s of snaps) {
    const c = await candlesFor(dir, s);
    const kept = findPatterns(c, DEFAULT_PATTERNS);
    const ours = s.mode === 'all' ? kept : visiblePatterns(kept, 'last');
    const r = score(c, s, ours);
    const t = (tot[s.mode ?? 'last'] ??= { F: 0, M: 0, E: 0, S: 0 });
    t.F += r.found;
    t.M += r.missed;
    t.E += r.extra;
    t.S += r.sameStatus;
    for (const l of r.lines) {
      const kind = l.trim().split(/\s+/)[0]!;
      const name = `${s.mode ?? 'last'} ${l.slice(8, 36).trim()}`;
      const b = byName.get(name) ?? { f: 0, m: 0, e: 0 };
      if (kind === 'ok') b.f++;
      else if (kind === 'MISS') b.m++;
      else b.e++;
      byName.set(name, b);
    }
    if (!quiet) console.log(`${s.mode} ${s.sym.padEnd(18)} ${s.res.padStart(3)}  bars ${String(c.length).padStart(4)}  found ${r.found}/${r.found + r.missed}  extra ${r.extra}`);
    if (verbose) for (const l of r.lines) console.log(l);
  }
  for (const [m, t] of Object.entries(tot))
    console.log(`TOTAL ${m}: found ${t.F}/${t.F + t.M}  extra ${t.E}  same status ${t.S}/${t.F}`);
  if (!quiet || process.argv.includes('--fam'))
    for (const [n, b] of [...byName].sort()) if (!process.argv.includes('--fam') || n.startsWith('all')) console.log(`  ${n.padEnd(34)} found ${b.f}  missed ${b.m}  extra ${b.e}`);
}

if (process.argv[1]?.includes('compare-patterns')) main();
