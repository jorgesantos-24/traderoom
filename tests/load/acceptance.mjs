// Final acceptance run (milestone 8), on the production builds, against the live Binance feed:
//
//   1. Load: 500 WebSocket clients for 10 min (tests/load/ws-load.mjs), while 15 users place
//      1-minute orders every 10 s and every client loads candles once, like the front does on boot.
//      Two settlement workers run at once, competing for the same queue.
//   2. Checks: tick p95 < 1 s, ws RSS < 1.5 GB, zero 429/418 from Binance, every order settled
//      exactly once (ledger + both workers' counters), balances equal the sum of their ledger.
//   3. Feed kill: SIGKILL the relay (ws process), measure how long until orders are refused as
//      stale, then restart it and measure recovery of orders and of a WS client.
//
// Needs `npm run dev:deps`, `npm run db:migrate`, `npm run build`, and nothing listening on
// 3000/3001/3002/3012. Results go to tests/load/results/<timestamp>/.
//
//   node tests/load/acceptance.mjs
//   VUS=50 HOLD_SEC=60 node tests/load/acceptance.mjs      # quick rehearsal
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const envFile = `${ROOT}.env`;
if (existsSync(envFile)) process.loadEnvFile(envFile);
const requireApi = createRequire(`${ROOT}apps/api/package.json`);
const requireWs = createRequire(`${ROOT}apps/ws/package.json`);
const pg = requireApi('pg');
const { WebSocket } = requireWs('ws');

const VUS = Number(process.env.VUS ?? 500);
const HOLD_SEC = Number(process.env.HOLD_SEC ?? 600);
const RAMP_SEC = Number(process.env.RAMP_SEC ?? 30);
const TRADERS = Number(process.env.TRADERS ?? 15);
const ORDER_EVERY_MS = Number(process.env.ORDER_EVERY_SEC ?? 10) * 1000;
const ASSETS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const API = 'http://127.0.0.1:3000';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = `${ROOT}tests/load/results/${stamp}/`;
mkdirSync(OUT, { recursive: true });
const SESSIONS_FILE = `${OUT}sessions.json`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

// ---- processes ----

const children = new Map();
function start(name, script, extraEnv = {}) {
  const out = createWriteStream(`${OUT}${name}.log`, { flags: 'a' });
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  children.set(name, child);
  return child;
}
function stop(name, signal = 'SIGTERM') {
  const c = children.get(name);
  if (c && c.exitCode === null) c.kill(signal);
  children.delete(name);
}
async function waitHttp(url, okStatus = (s) => s === 200, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if (okStatus((await fetch(url)).status)) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`${url} did not come up`);
}
async function metric(url, name) {
  const text = await (await fetch(url)).text();
  const out = {};
  for (const line of text.split('\n')) {
    if (!line.startsWith(name)) continue;
    const m = /^(\S+?)(\{[^}]*\})? (\S+)$/.exec(line);
    if (m && m[1] === name) out[m[2] ?? ''] = Number(m[3]);
  }
  return out;
}
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

const ENV_WS = { WS_HOST: '127.0.0.1', WS_PORT: '3001', WS_DATABASE_POOL_MAX: '8' };
const startWs = () => start('ws', 'apps/ws/dist/main.js', ENV_WS);
const API_ENV = { RATE_LIMIT_GLOBAL_PER_MIN: '1000000', DATABASE_POOL_MAX: '16' }; // every client shares 127.0.0.1 here

// ---- HTTP as a load user ----

const csrf = randomBytes(32).toString('base64url');
async function apiCall(sid, method, path, body, extra = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      cookie: `sid=${sid}; __Host-csrf=${csrf}`,
      'x-csrf-token': csrf,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function credit(email, cents) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const { rows } = await c.query(
      'select a.user_id, a.balance_cents from accounts a join users u on u.id = a.user_id where u.email = $1 for update of a',
      [email],
    );
    const after = Number(rows[0].balance_cents) + cents;
    await c.query('update accounts set balance_cents = $2 where user_id = $1', [rows[0].user_id, after]);
    await c.query(`insert into ledger (user_id, delta_cents, balance_after, kind, note) values ($1, $2, $3, 'credit', 'carga')`, [
      rows[0].user_id,
      cents,
      after,
    ]);
    await c.query('commit');
  } catch (err) {
    await c.query('rollback');
    throw err;
  } finally {
    c.release();
  }
}

async function cleanupLoadUsers() {
  const users = `select id from users where email like '%@load.test'`;
  await pool.query(`delete from ledger where user_id in (${users})`);
  await pool.query(`delete from orders where user_id in (${users})`);
  await pool.query(`delete from users where email like '%@load.test'`);
}

function runNode(script, args, env) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(`${OUT}${script.split('/').pop()}.log`, { flags: 'a' });
    const c = spawn(process.execPath, [script, ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout.pipe(out);
    c.stderr.pipe(out);
    c.stdout.on('data', (d) => process.stdout.write(d));
    c.on('exit', (code) => (code === 0 || code === 1 ? resolve(code) : reject(new Error(`${script} exited ${code}`))));
  });
}

// ---- phases ----

const report = { startedAt: new Date().toISOString(), config: { VUS, HOLD_SEC, RAMP_SEC, TRADERS, ORDER_EVERY_SEC: ORDER_EVERY_MS / 1000 } };

async function setup() {
  log('cleaning old load users and creating', VUS + 1);
  await cleanupLoadUsers();
  await runNode('apps/api/dist/cli/load-users.js', ['create', String(VUS + 1), SESSIONS_FILE], { NODE_ENV: 'development' });
  const sessions = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
  const toCredit = sessions.slice(0, TRADERS + 1);
  for (let i = 0; i < toCredit.length; i += 20) await Promise.all(toCredit.slice(i, i + 20).map((s) => credit(s.email, 1_000_000)));
  log('starting ws, api and two workers (production builds)');
  startWs();
  start('api', 'apps/api/dist/main.js', API_ENV);
  start('worker-a', 'apps/api/dist/worker.js', { WORKER_PORT: '3002' });
  start('worker-b', 'apps/api/dist/worker.js', { WORKER_PORT: '3012' });
  await Promise.all([
    waitHttp('http://127.0.0.1:3001/healthz'),
    waitHttp(`${API}/api/health`),
    waitHttp('http://127.0.0.1:3002/healthz'),
    waitHttp('http://127.0.0.1:3012/healthz'),
  ]);
  return sessions;
}

async function loadPhase(sessions) {
  const traders = sessions.slice(0, TRADERS);
  const orders = { sent: 0, created: 0, byStatus: {}, ids: [] };
  const candles = { sent: 0, byStatus: {}, slowestMs: 0, msList: [] };
  const perUser = sessions.slice(0, VUS).map(() => ({ candles: null, created: 0, refused: {} }));
  const endAt = Date.now() + (RAMP_SEC + HOLD_SEC) * 1000;

  // Each client's front loads candles once on boot, spread over the ramp.
  const candleJobs = sessions.slice(0, VUS).map(async (s, i) => {
    await sleep((i / VUS) * RAMP_SEC * 1000);
    const t0 = Date.now();
    const r = await apiCall(s.sid, 'GET', `/api/candles?symbol=${ASSETS[i % ASSETS.length]}&interval=1m&limit=500`);
    candles.msList.push(Date.now() - t0);
    perUser[i].candles = r.status;
    candles.sent += 1;
    candles.byStatus[r.status] = (candles.byStatus[r.status] ?? 0) + 1;
  });

  const traderJobs = traders.map(async (s, i) => {
    await sleep((i / traders.length) * ORDER_EVERY_MS);
    while (Date.now() + 60_000 < endAt) {
      const body = {
        assetId: 0,
        direction: Math.random() < 0.5 ? 'call' : 'put',
        stakeCents: 1000,
        durationSec: 60,
      };
      body.assetId = assetIds[ASSETS[Math.floor(Math.random() * ASSETS.length)]];
      const r = await apiCall(s.sid, 'POST', '/api/orders', body, { 'idempotency-key': randomUUID() });
      orders.sent += 1;
      const key = r.status === 201 ? 201 : `${r.status} ${r.json?.error?.code ?? ''}`;
      orders.byStatus[key] = (orders.byStatus[key] ?? 0) + 1;
      if (r.status !== 201) perUser[i].refused[key] = (perUser[i].refused[key] ?? 0) + 1;
      if (r.status === 201) {
        perUser[i].created += 1;
        orders.created += 1;
        orders.ids.push(r.json.order.id);
      }
      await sleep(ORDER_EVERY_MS);
    }
  });

  log(`load: ${VUS} WS clients for ${HOLD_SEC}s (+${RAMP_SEC}s ramp), ${TRADERS} traders`);
  const wsCode = await runNode('tests/load/ws-load.mjs', [], {
    VUS: String(VUS),
    HOLD_SEC: String(HOLD_SEC),
    RAMP_SEC: String(RAMP_SEC),
    SESSIONS: SESSIONS_FILE,
    RESULT_FILE: `${OUT}ws-load.json`,
  });
  await Promise.all([...candleJobs, ...traderJobs]);
  report.wsLoad = JSON.parse(readFileSync(`${OUT}ws-load.json`, 'utf8'));
  report.wsLoad.exitCode = wsCode;
  report.orders = { sent: orders.sent, created: orders.created, byStatus: orders.byStatus };
  candles.msList.sort((a, b) => a - b);
  const at = (p) => candles.msList[Math.min(candles.msList.length - 1, Math.floor(p * candles.msList.length))];
  report.candles = { sent: candles.sent, byStatus: candles.byStatus, ms: { p50: at(0.5), p95: at(0.95), max: candles.msList.at(-1) } };
  const traders_ = perUser.slice(0, TRADERS);
  report.perUser = {
    chartLoadFailed: perUser.filter((u) => u.candles !== 200).length,
    tradersWithNoOrder: traders_.filter((u) => u.created === 0).length,
    tradersWithARefusal: traders_.filter((u) => Object.keys(u.refused).length > 0).length,
    ordersPerTrader: { min: Math.min(...traders_.map((u) => u.created)), max: Math.max(...traders_.map((u) => u.created)) },
  };
  return orders.ids;
}

async function settlementChecks(ids) {
  log(`waiting for ${ids.length} orders to settle`);
  const until = Date.now() + 120_000;
  let open = ids.length;
  while (Date.now() < until) {
    const { rows } = await pool.query(`select count(*)::int as n from orders where id = any($1::uuid[]) and status = 'open'`, [ids]);
    open = rows[0].n;
    if (open === 0) break;
    await sleep(2000);
  }
  const dup = await pool.query(
    `select order_id, count(*)::int as n from ledger
      where order_id = any($1::uuid[]) and kind in ('payout', 'refund') group by order_id having count(*) > 1`,
    [ids],
  );
  const mismatch = await pool.query(
    `select o.id from orders o
       left join ledger l on l.order_id = o.id and l.kind in ('payout', 'refund')
      where o.id = any($1::uuid[])
      group by o.id, o.status
     having (o.status in ('won', 'void') and count(l.id) <> 1) or (o.status = 'lost' and count(l.id) <> 0)`,
    [ids],
  );
  const balances = await pool.query(
    `select a.user_id from accounts a join users u on u.id = a.user_id
      where u.email like '%@load.test'
        and a.balance_cents <> coalesce((select sum(delta_cents) from ledger l where l.user_id = a.user_id), 0)`,
  );
  const statuses = await pool.query(`select status, count(*)::int as n from orders where id = any($1::uuid[]) group by status`, [ids]);
  // Sanity check of the rule itself: with random directions, wins and losses should be roughly even.
  const byDirection = await pool.query(
    `select direction, status, count(*)::int as n,
            count(*) filter (where (direction = 'call' and close_price > open_price) or (direction = 'put' and close_price < open_price))::int as by_rule
       from orders where id = any($1::uuid[]) group by direction, status order by direction, status`,
    [ids],
  );
  const settledA = sum(await metric('http://127.0.0.1:3002/metrics', 'settlements_total'));
  const settledB = sum(await metric('http://127.0.0.1:3012/metrics', 'settlements_total'));
  const lag = await metric('http://127.0.0.1:3002/metrics', 'settlement_lag_ms');
  report.settlement = {
    orders: ids.length,
    stillOpen: open,
    byStatus: Object.fromEntries(statuses.rows.map((r) => [r.status, r.n])),
    // by_rule = how many in that row a fresh recomputation calls a win; must equal n for won, 0 otherwise.
    byDirection: byDirection.rows,
    workerA: settledA,
    workerB: settledB,
    duplicatePayouts: dup.rowCount,
    ledgerMismatches: mismatch.rowCount,
    balanceMismatches: balances.rowCount,
    lastLagMs: lag[''] ?? null,
  };
}

async function binanceChecks() {
  const byStatus = await metric(`${API}/metrics`, 'binance_rest_responses_total');
  report.binance = Object.fromEntries(Object.entries(byStatus).map(([k, v]) => [k.replace(/[{}"]/g, '').replace('status=', ''), v]));
}

async function feedKill(sessions) {
  const trader = sessions[TRADERS];
  const btc = assetIds.BTCUSDT;
  const order = () =>
    apiCall(trader.sid, 'POST', '/api/orders', { assetId: btc, direction: 'call', stakeCents: 100, durationSec: 60 }, { 'idempotency-key': randomUUID() });

  // A browser-like client that reconnects every second, like the front's backoff floor.
  const client = { ticksAfterRestart: 0, firstTickAfterRestartAt: null, restartedAt: null, closedAt: null };
  let ws;
  const connect = () => {
    ws = new WebSocket('ws://127.0.0.1:3001/ws', { headers: { cookie: `sid=${trader.sid}` } });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'sub', assets: ['BTCUSDT'] })));
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.t === 'tick' && client.restartedAt !== null) {
        client.ticksAfterRestart += 1;
        client.firstTickAfterRestartAt ??= Date.now();
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      client.closedAt ??= Date.now();
      if (!client.done) setTimeout(connect, 1000);
    });
  };
  connect();
  await sleep(5000);
  const before = await order();

  log('feed kill: SIGKILL the ws process (relay + gateway)');
  const killedAt = Date.now();
  stop('ws', 'SIGKILL');
  let staleAfterMs = null;
  let acceptedWhileDying = 0;
  while (Date.now() - killedAt < 10_000) {
    const r = await order();
    if (r.status === 201) acceptedWhileDying += 1;
    if (r.status === 409 && r.json?.error?.code === 'asset_stale') {
      staleAfterMs = Date.now() - killedAt;
      break;
    }
    await sleep(100);
  }
  await sleep(Math.max(0, 6000 - (Date.now() - killedAt)));
  const healthDuringOutage = (await fetch(`${API}/api/health`)).status;

  log('restarting ws');
  client.restartedAt = Date.now();
  startWs();
  let recoveredAfterMs = null;
  while (Date.now() - client.restartedAt < 60_000) {
    const r = await order();
    if (r.status === 201) {
      recoveredAfterMs = Date.now() - client.restartedAt;
      break;
    }
    await sleep(250);
  }
  await waitHttp(`${API}/api/health`, (s) => s === 200, 30_000).catch(() => {});
  await sleep(3000);
  client.done = true;
  ws.close();
  report.feedKill = {
    orderBeforeKill: before.status,
    clientSawClose: client.closedAt !== null,
    clientCloseAfterMs: client.closedAt === null ? null : client.closedAt - killedAt,
    ordersAcceptedBeforeStale: acceptedWhileDying,
    ordersRefusedStaleAfterMs: staleAfterMs,
    healthDuringOutage,
    ordersAcceptedAgainAfterMs: recoveredAfterMs,
    wsClientTicksAfterMs: client.firstTickAfterRestartAt === null ? null : client.firstTickAfterRestartAt - client.restartedAt,
  };
}

let assetIds = {};
let exitCode = 1;
try {
  const { rows } = await pool.query('select id, symbol from assets where enabled');
  assetIds = Object.fromEntries(rows.map((r) => [r.symbol, r.id]));
  const sessions = await setup();
  const ids = await loadPhase(sessions);
  await binanceChecks();
  await settlementChecks(ids);
  await feedKill(sessions);
  await sleep(75_000); // let the feed-kill orders settle too
  const { rows: leftover } = await pool.query(
    `select count(*)::int as n from orders o join users u on u.id = o.user_id where u.email like '%@load.test' and o.status = 'open'`,
  );
  report.openAfterAll = leftover[0].n;

  const w = report.wsLoad;
  const s = report.settlement;
  const f = report.feedKill;
  report.checks = {
    'every user: chart loaded': report.perUser.chartLoadFailed === 0,
    'every user: got live prices': w.clients.withoutTicks === 0,
    'every user: chart never froze > 3 s': w.clients.frozenOver3s === 0,
    'every trader: placed orders': report.perUser.tradersWithNoOrder === 0,
    'WS: all clients connected': w.connectFailed === 0 && w.connected === VUS,
    'WS: tick p95 < 1000 ms': w.latencyMs.p95 < 1000,
    'WS: seq out of order == 0': w.outOfOrder === 0,
    'WS: unexpected closes == 0': Object.values(w.unexpectedCloses).reduce((a, b) => a + b, 0) === 0,
    'ws RSS < 1.5 GB': w.rssMb.max > 0 && w.rssMb.max < 1536,
    'Binance: zero 429/418': !report.binance['429'] && !report.binance['418'],
    'orders: placed during load': report.orders.created > 0,
    'orders: all settled': s.stillOpen === 0 && report.openAfterAll === 0,
    'orders: settled exactly once (ledger)': s.duplicatePayouts === 0 && s.ledgerMismatches === 0,
    'orders: outcome matches open/close prices': s.byDirection.every((r) => (r.status === 'won' ? r.by_rule === r.n : r.by_rule === 0)),
    'orders: settled exactly once (both workers)': s.workerA + s.workerB === s.orders,
    'balances == sum(ledger)': s.balanceMismatches === 0,
    'feed kill: refused as stale within 2.5 s': f.ordersRefusedStaleAfterMs !== null && f.ordersRefusedStaleAfterMs <= 2500,
    'feed kill: /api/health 503 while down': f.healthDuringOutage === 503,
    'feed kill: orders accepted again': f.ordersAcceptedAgainAfterMs !== null,
    'feed kill: WS client recovers': f.wsClientTicksAfterMs !== null,
  };
  exitCode = Object.values(report.checks).every(Boolean) ? 0 : 1;
} catch (err) {
  report.error = String(err?.stack ?? err);
  console.error(err);
} finally {
  for (const name of [...children.keys()]) stop(name);
  await sleep(1500);
  await cleanupLoadUsers().catch((e) => console.error('cleanup failed', e));
  await pool.end();
  report.finishedAt = new Date().toISOString();
  writeFileSync(`${OUT}report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  log(`report: ${OUT}report.json`);
  process.exit(exitCode);
}
