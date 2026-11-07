// Node load generator for the WS gateway: same scenario and thresholds as tests/k6/ws-load.js,
// for machines without k6. Also samples the ws process RSS from /metrics.
//
//   npm run load-users -w @traderoom/api -- create 500 ../../tests/k6/.sessions.json
//   node tests/load/ws-load.mjs                     # 500 clients, 10 min
//   VUS=50 HOLD_SEC=60 node tests/load/ws-load.mjs
//   RESULT_FILE=out.json node tests/load/ws-load.mjs   # also writes the summary as JSON
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../apps/ws/package.json', import.meta.url));
const { WebSocket } = require('ws');

const env = process.env;
const WS_URL = env.WS_URL ?? 'ws://127.0.0.1:3001/ws';
const METRICS_URL = env.METRICS_URL ?? 'http://127.0.0.1:3001/metrics';
const SESSIONS = env.SESSIONS ?? new URL('../k6/.sessions.json', import.meta.url);
const VUS = Number(env.VUS ?? 500);
const HOLD_MS = Number(env.HOLD_SEC ?? 600) * 1000;
const RAMP_MS = Number(env.RAMP_SEC ?? 30) * 1000;
const ASSETS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

// Tick ts is Binance's clock; measure how far ours is off (best of 5, by lowest round trip).
async function clockOffsetMs() {
  let best = { rtt: Infinity, off: 0 };
  for (let i = 0; i < 5; i++) {
    try {
      const t0 = Date.now();
      const { serverTime } = await (await fetch('https://api.binance.com/api/v3/time')).json();
      const t1 = Date.now();
      if (t1 - t0 < best.rtt) best = { rtt: t1 - t0, off: Math.round((t0 + t1) / 2 - serverTime) };
    } catch {
      // keep the best so far
    }
  }
  return best.off;
}
const CLOCK_OFFSET = Number(env.CLOCK_OFFSET_MS ?? (await clockOffsetMs()));
console.log(`clock offset vs Binance: ${CLOCK_OFFSET} ms (subtracted from latencies)`);

const sessions = JSON.parse(readFileSync(SESSIONS, 'utf8'));
if (sessions.length < VUS) throw new Error(`need ${VUS} sessions, file has ${sessions.length}`);

const latencies = [];
const stats = { connected: 0, connectFailed: 0, ticks: 0, snapshots: 0, outOfOrder: 0, errorFrames: 0, unexpectedCloses: {}, pongs: 0 };
// Per client: ticks received and the longest silence between two ticks (a frozen chart).
const perClient = [];
const FREEZE_MS = 3000;
let maxRss = 0;
let lastRss = 0;

function pickAssets(vu) {
  const extra = ASSETS.slice(1);
  const picked = ['BTCUSDT'];
  for (let i = 0; i < vu % 3; i++) picked.push(extra[(vu * 7 + i * 3) % extra.length]);
  return [...new Set(picked)];
}

function runClient(vu) {
  return new Promise((resolve) => {
    const startDelay = ((vu - 1) / VUS) * RAMP_MS;
    setTimeout(() => {
      let lastSeq = 0;
      let purposeful = false;
      let opened = false;
      const me = { vu, ticks: 0, lastTickAt: 0, maxGapMs: 0 };
      perClient.push(me);
      const ws = new WebSocket(WS_URL, { headers: { cookie: `sid=${sessions[vu - 1].sid}` }, perMessageDeflate: false });
      let ping;
      ws.on('open', () => {
        opened = true;
        stats.connected += 1;
        ws.send(JSON.stringify({ t: 'sub', assets: pickAssets(vu) }));
        ping = setInterval(() => ws.send('{"t":"ping"}'), 15_000);
        setTimeout(() => {
          purposeful = true;
          ws.close(1000);
        }, HOLD_MS + RAMP_MS - startDelay);
      });
      ws.on('message', (raw) => {
        const now = Date.now();
        const f = JSON.parse(raw.toString());
        if (typeof f.seq === 'number') {
          if (f.seq <= lastSeq) stats.outOfOrder += 1;
          lastSeq = f.seq;
        }
        if (f.t === 'tick') {
          stats.ticks += 1;
          me.ticks += 1;
          if (me.lastTickAt) me.maxGapMs = Math.max(me.maxGapMs, now - me.lastTickAt);
          me.lastTickAt = now;
          for (const d of f.data) latencies.push(now - CLOCK_OFFSET - d.ts);
        } else if (f.t === 'snapshot') stats.snapshots += 1;
        else if (f.t === 'pong') stats.pongs += 1;
        else if (f.t === 'error') stats.errorFrames += 1;
      });
      ws.on('error', () => {});
      ws.on('close', (code) => {
        clearInterval(ping);
        if (!opened) stats.connectFailed += 1;
        else if (!purposeful) stats.unexpectedCloses[code] = (stats.unexpectedCloses[code] ?? 0) + 1;
        resolve();
      });
    }, startDelay);
  });
}

async function sampleRss() {
  try {
    const text = await (await fetch(METRICS_URL)).text();
    const m = /^process_resident_memory_bytes (\d+)/m.exec(text);
    if (m) {
      lastRss = Number(m[1]);
      maxRss = Math.max(maxRss, lastRss);
    }
  } catch {
    // ws process unreachable; reported as 0
  }
}

function pct(sorted, p) {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const started = Date.now();
await sampleRss();
const rssBefore = lastRss;
const sampler = setInterval(() => void sampleRss(), 5000);
const progress = setInterval(() => {
  const s = Math.round((Date.now() - started) / 1000);
  console.log(`[${s}s] connected=${stats.connected} ticks=${stats.ticks} rss=${(lastRss / 1048576).toFixed(0)}MB`);
}, 30_000);

await Promise.all(Array.from({ length: VUS }, (_, i) => runClient(i + 1)));
clearInterval(sampler);
clearInterval(progress);
await sampleRss();

latencies.sort((a, b) => a - b);
const unexpected = Object.values(stats.unexpectedCloses).reduce((a, b) => a + b, 0);
const p95 = pct(latencies, 95);
const gaps = perClient.map((c) => c.maxGapMs).sort((a, b) => a - b);
const clients = {
  withoutTicks: perClient.filter((c) => c.ticks === 0).length,
  frozenOver3s: perClient.filter((c) => c.maxGapMs > FREEZE_MS).length,
  ticksPerClient: { min: Math.min(...perClient.map((c) => c.ticks)), max: Math.max(...perClient.map((c) => c.ticks)) },
  longestGapMs: { p50: pct(gaps, 50), p99: pct(gaps, 99), max: gaps.at(-1) },
};
const checks = {
  'every client got ticks': clients.withoutTicks === 0,
  'no client chart froze > 3 s': clients.frozenOver3s === 0,
  'connect ok == 100%': stats.connectFailed === 0 && stats.connected === VUS,
  'tick p95 < 1000 ms': p95 < 1000,
  'seq out of order == 0': stats.outOfOrder === 0,
  'unexpected closes == 0': unexpected === 0,
  'error frames == 0': stats.errorFrames === 0,
  'ws RSS < 1.5 GB': maxRss > 0 && maxRss < 1.5 * 1024 ** 3,
};
const result = {
  vus: VUS,
  clockOffsetMs: CLOCK_OFFSET,
  durationSec: Math.round((Date.now() - started) / 1000),
  ...stats,
  latencyMs: { p50: pct(latencies, 50), p95, p99: pct(latencies, 99), max: latencies.at(-1) },
  rssMb: { before: Math.round(rssBefore / 1048576), max: Math.round(maxRss / 1048576) },
  clients,
  checks,
};
if (env.RESULT_FILE) writeFileSync(env.RESULT_FILE, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
