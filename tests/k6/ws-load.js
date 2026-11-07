// k6 load test for the WS gateway (k6 >= 1.0, module k6/websockets).
//
//   npm run load-users -w @traderoom/api -- create 500 ../../tests/k6/.sessions.json
//   k6 run tests/k6/ws-load.js                       # 500 VUs, 10 min (spec)
//   k6 run -e VUS=50 -e HOLD_SEC=60 tests/k6/ws-load.js
//
// Env: WS_URL (default ws://127.0.0.1:3001/ws), SESSIONS (default ./.sessions.json),
//      VUS (500), HOLD_SEC (600), RAMP_SEC (30), ORIGIN (optional Origin header).
//
// tick_latency_ms = client receive time - price time. With Binance bookTicker the price
// time is the relay's receive time, so run k6 on the same host (or an NTP-synced one).
import { WebSocket } from 'k6/websockets';
import { clearInterval, setInterval, setTimeout } from 'k6/timers';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';

const sessions = new SharedArray('sessions', () => JSON.parse(open(__ENV.SESSIONS || './.sessions.json')));
const WS_URL = __ENV.WS_URL || 'ws://127.0.0.1:3001/ws';
const VUS = Number(__ENV.VUS || 500);
const HOLD_MS = Number(__ENV.HOLD_SEC || 600) * 1000;
const RAMP_MS = Number(__ENV.RAMP_SEC || 30) * 1000;
const ASSETS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT'];

const tickLatency = new Trend('tick_latency_ms', true);
const ticks = new Counter('ticks_received');
const snapshots = new Counter('snapshots_received');
const outOfOrder = new Counter('seq_out_of_order');
const errorFrames = new Counter('error_frames');
const unexpectedCloses = new Counter('unexpected_closes');
const connectOk = new Rate('ws_connect_ok');

export const options = {
  scenarios: {
    hold: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: `${Math.ceil((HOLD_MS + RAMP_MS) / 1000) + 120}s`,
    },
  },
  thresholds: {
    tick_latency_ms: ['p(95)<1000'],
    seq_out_of_order: ['count==0'],
    unexpected_closes: ['count==0'],
    error_frames: ['count==0'],
    ws_connect_ok: ['rate==1'],
    ticks_received: ['count>0'],
  },
};

/** 1–3 assets per client; everyone watches BTC (the busiest stream). */
function pickAssets(vu) {
  const extra = ASSETS.slice(1);
  const picked = ['BTCUSDT'];
  for (let i = 0; i < vu % 3; i++) picked.push(extra[(vu * 7 + i * 3) % extra.length]);
  return [...new Set(picked)];
}

export default function () {
  if (sessions.length < VUS) throw new Error(`need ${VUS} sessions, file has ${sessions.length}`);
  const session = sessions[__VU - 1];
  const startDelay = ((__VU - 1) / VUS) * RAMP_MS;
  const holdMs = HOLD_MS + RAMP_MS - startDelay;

  // Spread connects over the ramp so the handshake burst looks like real traffic.
  setTimeout(() => {
    const headers = { Cookie: `sid=${session.sid}` };
    if (__ENV.ORIGIN) headers.Origin = __ENV.ORIGIN;
    const ws = new WebSocket(WS_URL, null, { headers });
    let opened = false;
    let closingOnPurpose = false;
    let lastSeq = 0;
    let ping;

    ws.onopen = () => {
      opened = true;
      connectOk.add(true);
      ws.send(JSON.stringify({ t: 'sub', assets: pickAssets(__VU) }));
      ping = setInterval(() => ws.send(JSON.stringify({ t: 'ping' })), 15_000);
      setTimeout(() => {
        closingOnPurpose = true;
        ws.close();
      }, holdMs);
    };

    ws.onmessage = (e) => {
      const now = Date.now();
      const f = JSON.parse(e.data);
      if (typeof f.seq === 'number') {
        if (f.seq <= lastSeq) outOfOrder.add(1);
        lastSeq = f.seq;
      }
      if (f.t === 'tick') {
        ticks.add(1);
        for (const d of f.data) tickLatency.add(now - d.ts);
      } else if (f.t === 'snapshot') {
        snapshots.add(1);
      } else if (f.t === 'error') {
        errorFrames.add(1, { code: f.code });
      }
    };

    ws.onerror = () => {
      if (!opened) connectOk.add(false);
    };

    ws.onclose = () => {
      clearInterval(ping);
      if (opened && !closingOnPurpose) unexpectedCloses.add(1);
    };
  }, startDelay);
}
