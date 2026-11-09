// Manual end-to-end check of the price override (no UI, no admin routes).
//
//   node tests/manual/otc-override.mjs [--symbol BTCOTC] [--up|--down] [--target 75900.00] [--pct 0.2]
//        [--release 45000] [--unlimited] [--no-jitter] [--early] [--ws-log ws.log]
//     --no-jitter: manda jitter: false no wire (hold cravado no alvo) e compara a, b, d e g exatamente.
//       Sem ele, o hold oscila dentro da banda do OverridePath e esses critérios aceitam a banda.
//     --release: tempo de volta ao preço real, em ms (500..600000). O padrão é o de 2 s.
//     --unlimited / --pct: alvo maior. Sem a API o limite max_override_pct não é aplicado aqui; --unlimited
//       só serve para o alvo padrão crescer (1%), e --pct define o tamanho à mão.
//     --early: writes the override right after the candle opens (~50 s before the ramp) instead of just before it.
//   node tests/manual/otc-override.mjs --watch [--symbol BTCOTC] [--up|--down|--target X]
//   node tests/manual/otc-override.mjs --clean
//
// OTC e mercado: em ativo de mercado a rampa ocupa o resto do candle e o alvo pode passar da banda.
// Needs: docker deps, migrations, `npm run build -w @traderoom/shared` and `npm run dev:ws` running.
// The settlement worker is started here (and stopped at the end) if it is not already up.
// Exit code 0 only if every criterion passes.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Redis } from 'ioredis';
import {
  OTC_OVERRIDE_HOLD_MS as HOLD_MS,
  OTC_OVERRIDE_KEY as OVERRIDE_KEY,
  OTC_OVERRIDE_LANDING_MS as LANDING_MS,
  OTC_OVERRIDE_MIN_LEAD_MS as MIN_LEAD_MS,
  OTC_OVERRIDE_RAMP_DEFAULT_MS as RAMP_MS,
  OTC_OVERRIDE_RELEASE_MAX_MS as RELEASE_MAX_MS,
  OTC_OVERRIDE_RELEASE_MIN_MS as RELEASE_MIN_MS,
  OTC_OVERRIDE_RELEASE_MS as RELEASE_MS,
  otcOverrideRampStartMs,
  RedisKeys,
} from '@traderoom/shared';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const CANDLE_MS = 60_000;
const POLL_MS = 250;
const SETTLE_TIMEOUT_MS = 15_000;
const STAKE_CENTS = 10_000;
const BALANCE_CENTS = 100_000;
/** Required gap between the price after the release and the natural price. */
const BACK_MAX_PCT = 0.1;
/** Snapshots the hold must yield (relay writes 1/s; settlement looks back 3 s). */
const HOLD_SNAPSHOTS_MIN = 3;
/** The override is written this long before the ramp, so `base` is the price the ramp starts from. */
const WRITE_BEFORE_RAMP_MS = 1500;
/** Release check on k itself: k_eff = (p − from) / (real − from), the k the tick used (clock-free). */
const RELEASE_K_TOL = 0.08;
/** k_eff may never go back more than this between two ticks. */
const RELEASE_K_BACK = 0.01;
/** Skip ticks where |real − from| is under this share of the distance: near the root k_eff blows up. */
const RELEASE_K_ROOT_FRAC = 0.05;
/** OTC: the exponential must have converged, k_eff at the last release tick at least this. */
const OTC_RELEASE_K_MIN = 0.85;
/** OTC: at the end of the release the price sits within this share of the distance from the shadow. */
const OTC_RELEASE_END_FRAC = 0.1;
/** A gap between two release ticks longer than this is a feed stall (reported, not failed). */
const RELEASE_STALL_MS = 2000;
const EMAIL_PREFIX = 'otc-override-';
const EMAIL_DOMAIN = '@teste.local';
// argon2id of "otc-override-test", same parameters as apps/api/src/lib/password.ts.
const PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$EZphsq1AeLRm2+Wu5Tdsaw$uq0kjEhA707nCWKJq7JvDHQeJWdt9KUaUV6qFL/5KAY';

// ---------- env and args ----------

function loadDotEnv() {
  const file = resolve(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue; // the real environment wins
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function parseArgs(argv) {
  const a = {
    symbol: 'BTCOTC',
    dir: 'up',
    target: null,
    pct: null,
    unlimited: false,
    releaseMs: RELEASE_MS,
    watch: false,
    clean: false,
    early: false,
    jitter: true,
    wsLog: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--symbol') a.symbol = String(argv[++i] ?? '').toUpperCase();
    else if (k === '--up') a.dir = 'up';
    else if (k === '--down') a.dir = 'down';
    else if (k === '--target') a.target = argv[++i];
    else if (k === '--pct') a.pct = Number(argv[++i]);
    else if (k === '--unlimited') a.unlimited = true;
    else if (k === '--release') a.releaseMs = Number(argv[++i]);
    else if (k === '--watch') a.watch = true;
    else if (k === '--clean') a.clean = true;
    else if (k === '--early') a.early = true;
    else if (k === '--no-jitter') a.jitter = false;
    else if (k === '--ws-log') a.wsLog = argv[++i];
    else die(`argumento desconhecido: ${k}`);
  }
  if (a.target !== null && !(Number(a.target) > 0)) die(`--target inválido: ${a.target}`);
  if (a.pct !== null && !(a.pct > 0 && a.pct < 50)) die(`--pct inválido: ${a.pct}`);
  if (!Number.isInteger(a.releaseMs) || a.releaseMs < RELEASE_MIN_MS || a.releaseMs > RELEASE_MAX_MS) {
    die(`--release inválido: use ${RELEASE_MIN_MS}..${RELEASE_MAX_MS} ms`);
  }
  return a;
}

function die(msg) {
  console.error(`ERRO: ${msg}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const iso = (ms) => new Date(ms).toISOString();
const same = (a, b, d) => a !== null && a !== undefined && b !== null && Number(a).toFixed(d) === Number(b).toFixed(d);
const pctGap = (a, b) => (Math.abs(Number(a) - Number(b)) / Number(b)) * 100;

function phaseAt(ms, ov) {
  if (ms < ov.rampStartMs) return 'natural';
  if (ms < ov.closeMs - ov.holdMs) return 'ramp';
  if (ms <= ov.closeMs) return 'hold';
  if (ms < ov.closeMs + ov.releaseMs) return 'release';
  return 'natural';
}

// ---------- worker ----------

async function workerUp() {
  const host = process.env.WORKER_HOST || '127.0.0.1';
  const port = process.env.WORKER_PORT || '3002';
  try {
    const r = await fetch(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Starts `npm run dev:worker` when nothing answers /healthz; returns a stop function (no-op if it was already up). */
async function ensureWorker() {
  if (await workerUp()) {
    console.log('worker: já está de pé');
    return async () => {};
  }
  console.log('worker: fora do ar; subindo `npm run dev:worker`');
  const child = spawn('npm', ['run', 'dev:worker'], { cwd: ROOT, shell: true, stdio: 'ignore', windowsHide: true });
  const deadline = Date.now() + 30_000;
  while (!(await workerUp())) {
    if (Date.now() > deadline) die('o worker não respondeu /healthz em 30 s');
    await sleep(500);
  }
  console.log('worker: de pé');
  return async () => {
    // npm → tsx watch → node: kill the whole tree.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
    console.log('worker: derrubado');
  };
}

// ---------- shared steps ----------

async function loadAsset(db, symbol) {
  const { rows } = await db.query(
    `select id, symbol, kind, enabled, payout_pct, coalesce(otc_decimals, price_decimals) as decimals, max_override_pct
       from assets where symbol = $1`,
    [symbol],
  );
  const a = rows[0];
  if (!a) die(`ativo ${symbol} não existe em assets`);
  if (a.kind !== 'otc' && a.kind !== 'market') die(`ativo ${symbol} não aceita override (kind=${a.kind})`);
  if (!a.enabled) die(`ativo ${symbol} está desabilitado`);
  if (a.decimals === null || a.decimals === undefined) die(`ativo ${symbol} não tem casas decimais configuradas`);
  return a;
}

async function readPx(redis, symbol) {
  const raw = await redis.get(RedisKeys.price(symbol));
  if (!raw) return null;
  const r = JSON.parse(raw);
  return {
    p: String(r.p),
    ts: Number(r.ts),
    // rt = tick.recvMs: when the relay received the tick, the clock PriceOverride.apply runs on.
    rt: r.rt === undefined || r.rt === null ? null : Number(r.rt),
    realPrice: r.realPrice ? String(r.realPrice) : null,
  };
}

/**
 * Candle with at least MIN_LEAD_MS left (else the next one), and the ramp length for this run.
 * - OTC: 'near-ramp' waits until just before the ramp, so base is the price the ramp starts from.
 * - Market: the ramp spans the rest of the candle, so it is written right away.
 * - 'early': waits for the next candle to open and writes right after the turnover (~50 s of lead).
 */
async function pickCandle(mode, market) {
  let now = Date.now();
  if (mode === 'early') {
    const next = (Math.floor(now / CANDLE_MS) + 1) * CANDLE_MS;
    console.log(`--early: aguardando a virada (${next - now} ms) para gravar logo que o candle abrir`);
    await sleep(next - now + 100);
    now = Date.now();
    const open = Math.floor(now / CANDLE_MS) * CANDLE_MS;
    const closeMs = open + CANDLE_MS;
    return { openMs: open, closeMs, rampMs: rampFor(closeMs, now, market) };
  }
  let open = Math.floor(now / CANDLE_MS) * CANDLE_MS;
  if (open + CANDLE_MS - now < MIN_LEAD_MS) {
    const wait = open + CANDLE_MS - now + 50;
    console.log(`faltam ${open + CANDLE_MS - now} ms para a virada (< ${MIN_LEAD_MS}); aguardando ${wait} ms`);
    await sleep(wait);
    now = Date.now();
    open = Math.floor(now / CANDLE_MS) * CANDLE_MS;
  }
  const closeMs = open + CANDLE_MS;
  if (market) return { openMs: open, closeMs, rampMs: rampFor(closeMs, now, market) };
  const writeAt = otcOverrideRampStartMs(0, closeMs, RAMP_MS) - WRITE_BEFORE_RAMP_MS;
  if (mode === 'near-ramp' && writeAt > now) {
    console.log(`aguardando ${writeAt - now} ms para gravar o override logo antes da rampa`);
    await sleep(writeAt - now);
  }
  return { openMs: open, closeMs, rampMs: RAMP_MS };
}

/** Market ramps over whatever is left of the candle; OTC uses the fixed 25 s. */
function rampFor(closeMs, nowMs, market) {
  if (!market) return RAMP_MS;
  return Math.min(60_000, Math.max(500, closeMs - nowMs - HOLD_MS - LANDING_MS));
}

function pickTarget(args, base, decimals, market) {
  if (args.target !== null) return Number(args.target).toFixed(decimals);
  const pct = args.pct ?? (args.unlimited && market ? 1 : 0.2);
  const factor = args.dir === 'down' ? 1 - pct / 100 : 1 + pct / 100;
  return (Number(base) * factor).toFixed(decimals);
}

async function writeOverride(redis, symbol, target, base, closeMs, rampMs, releaseMs, kind, jitter = true) {
  const now = Date.now();
  const payload = {
    // An id makes the ws mark ticks with `ov`, and only marked ticks carry realPrice in px. Not numeric,
    // so an order opened through the API meanwhile is recorded as natural (orders.ts filters /^\d+$/).
    id: `manual-${now}`,
    ...(kind === 'market' ? { kind: 'market' } : {}),
    // Absent means jitter on, as in the API's wire.
    ...(jitter ? {} : { jitter: false }),
    symbol,
    targetPrice: target,
    basePrice: base,
    closeMs,
    rampStartMs: otcOverrideRampStartMs(now, closeMs, rampMs),
    holdMs: HOLD_MS,
    releaseMs,
  };
  const ttl = closeMs + releaseMs - now + 10_000;
  await redis.set(OVERRIDE_KEY, JSON.stringify(payload), 'PX', ttl);
  console.log(`override gravado (TTL ${ttl} ms): ${JSON.stringify(payload)}`);
  return { ...payload, ttlMs: ttl, writtenAtMs: now };
}

/** Waits for the ws to log that it picked up this override. */
async function waitWsApplied(file, closeMs, timeoutMs = 3000) {
  if (!file) {
    console.log('AVISO: sem --ws-log; não foi possível confirmar "otc override applied" no log do ws');
    return null;
  }
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (existsSync(file)) {
      const line = readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .find((l) => l.includes('otc override applied') && l.includes(String(closeMs)));
      if (line) {
        console.log(`ws confirmou: ${line.trim()}`);
        return line.trim();
      }
    }
    await sleep(100);
  }
  return null;
}

// ---------- modes ----------

async function clean(db, redis) {
  const deleted = await redis.del(OVERRIDE_KEY);
  const like = `${EMAIL_PREFIX}%${EMAIL_DOMAIN}`;
  const client = await db.connect();
  try {
    await client.query('begin');
    const { rows: orders } = await client.query(`select o.id from orders o join users u on u.id = o.user_id where u.email like $1`, [like]);
    const ids = orders.map((r) => r.id);
    if (ids.length > 0) await redis.zrem(RedisKeys.ordersDue, ...ids);
    const l = await client.query(`delete from ledger where user_id in (select id from users where email like $1)`, [like]);
    const o = await client.query(`delete from orders where user_id in (select id from users where email like $1)`, [like]);
    await client.query(`delete from accounts where user_id in (select id from users where email like $1)`, [like]);
    const u = await client.query(`delete from users where email like $1`, [like]);
    await client.query('commit');
    console.log(`clean: chave ${OVERRIDE_KEY} ${deleted ? 'apagada' : 'não existia'}; usuários=${u.rowCount} ordens=${o.rowCount} ledger=${l.rowCount}`);
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

async function watch(db, redis, args) {
  const asset = await loadAsset(db, args.symbol);
  const market = asset.kind === 'market';
  const px = await readPx(redis, asset.symbol);
  if (!px) die(`sem preço em px:${asset.symbol}; o ws (npm run dev:ws) está rodando?`);
  const { closeMs, rampMs } = await pickCandle(args.early ? 'early' : 'now', market);
  const target = pickTarget(args, px.p, asset.decimals, market);
  const ov = await writeOverride(redis, asset.symbol, target, px.p, closeMs, rampMs, args.releaseMs, asset.kind, args.jitter);
  await waitWsApplied(args.wsLog, closeMs);
  console.log(`abra /traderoom, ${asset.symbol}, intervalo 1m. Candle fecha em ${iso(closeMs)} em ${target}.`);
  const end = Date.now() + 90_000 + args.releaseMs;
  while (Date.now() < end) {
    const now = Date.now();
    const cur = await readPx(redis, asset.symbol);
    const dist = cur ? (Number(cur.p) - Number(target)).toFixed(asset.decimals) : '-';
    console.log(`${iso(now)}  px=${cur?.p ?? '-'}  alvo-dist=${dist}  fase=${phaseAt(now, ov)}`);
    await sleep(POLL_MS - (Date.now() - now));
  }
}

/**
 * The feed must be ticking: 20 reads of px:<symbol>, 250 ms apart. Counts new ticks (distinct ts), not
 * distinct prices: on a 1-cent grid a quiet market alternates between two prices and is still alive.
 * Needs at least 3 distinct ts and the last one no older than 3 s; prints the mean spacing and, for the
 * record, how many distinct prices showed up (a low number means the market is flat, not the feed dead).
 */
async function assertFeedAlive(redis, symbol) {
  const stamps = new Set();
  const prices = new Set();
  let lastTs = null;
  for (let i = 0; i < 20; i++) {
    const px = await readPx(redis, symbol);
    if (px) {
      stamps.add(px.ts);
      prices.add(px.p);
      lastTs = px.ts;
    }
    if (i < 19) await sleep(250);
  }
  const ts = [...stamps].sort((a, b) => a - b);
  const meanGapMs = ts.length > 1 ? (ts.at(-1) - ts[0]) / (ts.length - 1) : null;
  const ageMs = lastTs === null ? null : Date.now() - lastTs;
  const gapText = meanGapMs === null ? '-' : `${Math.round(meanGapMs)} ms`;
  const summary = `${ts.length} tick(s) novo(s) em 20 leituras de 250 ms, espaçamento médio ${gapText}, último tick há ${ageMs ?? '-'} ms, ${prices.size} preço(s) distinto(s)`;
  if (ts.length < 3 || ageMs === null || ageMs > 3000) die(`feed de ${symbol} parado: ${summary} (mínimo 3 ticks, último ≤ 3000 ms)`);
  console.log(`feed de ${symbol} vivo: ${summary}`);
}

async function run(db, redis, args) {
  const asset = await loadAsset(db, args.symbol);
  await assertFeedAlive(redis, asset.symbol);
  const d = asset.decimals;
  const market = asset.kind === 'market';
  const { rows: cols } = await db.query(
    `select table_name, column_name from information_schema.columns
      where table_schema = 'public' and table_name in ('orders', 'accounts')`,
  );
  const hasOrderAccount = cols.some((c) => c.table_name === 'orders' && c.column_name === 'account');
  const hasAccountKind = cols.some((c) => c.table_name === 'accounts' && c.column_name === 'kind');
  if (!(await readPx(redis, asset.symbol))) die(`sem preço em px:${asset.symbol}; o ws (npm run dev:ws) está rodando?`);

  const { openMs, closeMs, rampMs } = await pickCandle(args.early ? 'early' : 'near-ramp', market);
  const px = await readPx(redis, asset.symbol);
  if (!px) die(`sem preço em px:${asset.symbol}; o ws (npm run dev:ws) está rodando?`);
  const base = px.p;
  const target = pickTarget(args, base, d, market);
  const up = Number(target) > Number(base);
  if (Number(target) === Number(base)) die('alvo igual ao preço atual; a ordem empataria');
  const gap = Math.abs(Number(target) - Number(base));
  // Hold band of the OverridePath: 10% of the body on the price grid, floor of 2 ticks.
  const tick = 10 ** -d;
  const band = Math.max(2, Math.round((0.1 * gap) / tick)) * tick;
  const within = (a, b) =>
    a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(Number(a) - Number(b)) <= band + tick / 2;
  /** Jitter on: the close lands inside the band; off: exactly on the target. */
  const onTarget = (a, b) => (args.jitter ? within(a, b) : same(a, b, d));
  const eqLabel = args.jitter ? `≈ alvo (±${band.toFixed(d)})` : '== alvo';
  console.log(`ativo ${asset.symbol} id=${asset.id} kind=${asset.kind} decimals=${d} payout=${asset.payout_pct}%`);
  console.log(`candle ${iso(openMs)} → ${iso(closeMs)}; base=${base} alvo=${target} (${up ? 'call' : 'put'}) rampa=${rampMs} ms`);
  if (market && asset.max_override_pct !== null) {
    const devPct = (Math.abs(Number(target) - Number(base)) / Number(base)) * 100;
    const limit = Number(asset.max_override_pct);
    console.log(`desvio ${devPct.toFixed(3)}% vs limite ${limit.toFixed(3)}% (${devPct > limit ? 'ACIMA — a API recusaria sem ignoreBand' : 'dentro'})`);
  }

  // User, account, order.
  const ts = Date.now();
  const email = `${EMAIL_PREFIX}${ts}${EMAIL_DOMAIN}`;
  const { rows: urows } = await db.query(`insert into users (email, password_hash, name, role) values ($1, $2, $3, 'user') returning id`, [
    email,
    PASSWORD_HASH,
    `Override ${ts}`,
  ]);
  const userId = urows[0].id;
  if (hasAccountKind) await db.query(`insert into accounts (user_id, kind, balance_cents) values ($1, 'real', $2)`, [userId, BALANCE_CENTS]);
  else await db.query(`insert into accounts (user_id, balance_cents) values ($1, $2)`, [userId, BALANCE_CENTS]);
  const orderCols = ['user_id', 'asset_id', 'direction', 'stake_cents', 'payout_pct', 'duration_sec', 'open_price', 'expires_at', 'idempotency_key', 'status'];
  const orderVals = [userId, asset.id, up ? 'call' : 'put', STAKE_CENTS, asset.payout_pct, 60, base, new Date(closeMs), randomUUID(), 'open'];
  if (hasOrderAccount) {
    orderCols.push('account');
    orderVals.push('real');
  }
  const { rows: orows } = await db.query(
    `insert into orders (${orderCols.join(', ')}) values (${orderCols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    orderVals,
  );
  const orderId = orows[0].id;
  // The API schedules every order here; without it only the 10 s DB sweep would find it.
  await redis.zadd(RedisKeys.ordersDue, closeMs, orderId);
  console.log(`usuário ${email} (${userId}), ordem ${orderId} (override_id nulo: o script não passa pela API)`);

  const ov = await writeOverride(redis, asset.symbol, target, base, closeMs, rampMs, args.releaseMs, asset.kind, args.jitter);
  const wsLine = await waitWsApplied(args.wsLog, closeMs);
  if (args.wsLog && !wsLine) die('o ws não registrou "otc override applied" em 3 s; abortando');

  // Price polling until the first tick at or after the end of the release.
  let atClose = null; // newest tick with ts <= closeMs
  let atRamp = null; // newest tick before the ramp: where the natural path was when the ramp took over
  let afterRelease = null; // first tick with ts >= closeMs + releaseMs
  let pttlAtClose = null;
  let keyGoneEarlyAt = null;
  const releaseEnd = closeMs + ov.releaseMs;
  const giveUp = releaseEnd + 5000;
  /** Release samples: distance from the target, to prove the return is gradual. */
  const releaseDist = [];
  /** Release ticks (distinct px.rt): price shown, real price and the relay's receive time. */
  const releaseTicks = [];
  /** Smallest |price - target| seen from rampStartMs to closeMs: proves the override acted. */
  let minDistInHold = Infinity;
  let prevRt = null;
  while (!afterRelease && Date.now() < giveUp) {
    const now = Date.now();
    const cur = await readPx(redis, asset.symbol);
    if (cur) {
      if (cur.ts < ov.rampStartMs && (!atRamp || cur.ts > atRamp.ts)) atRamp = cur;
      if (cur.ts <= closeMs && (!atClose || cur.ts > atClose.ts)) atClose = cur;
      if (cur.ts >= ov.rampStartMs && cur.ts <= closeMs) minDistInHold = Math.min(minDistInHold, Math.abs(Number(cur.p) - Number(target)));
      if (cur.ts >= releaseEnd) afterRelease = cur;
      if (now > ov.closeMs && now < releaseEnd) releaseDist.push({ at: now, dist: Math.abs(Number(cur.p) - Number(target)) });
      // Release ticks go in by the tick's own rt, inside (closeMs, releaseEnd), even when read after the
      // window closed. Only a new tick counts; a sample with the same rt is ignored.
      if (cur.rt !== null && cur.rt !== prevRt && cur.rt > ov.closeMs && cur.rt < releaseEnd) {
        releaseTicks.push({ rt: cur.rt, p: Number(cur.p), real: cur.realPrice === null ? null : Number(cur.realPrice) });
        prevRt = cur.rt;
      }
    }
    const pttl = await redis.pttl(OVERRIDE_KEY);
    if (pttl < 0 && now < releaseEnd && keyGoneEarlyAt === null) keyGoneEarlyAt = now;
    if (pttlAtClose === null && now >= closeMs) pttlAtClose = pttl;
    const dist = cur ? (Number(cur.p) - Number(target)).toFixed(d) : '-';
    console.log(`${iso(now)}  px=${cur?.p ?? '-'}  dist=${dist}  fase=${phaseAt(now, ov)}`);
    if (!afterRelease) await sleep(POLL_MS - (Date.now() - now));
  }
  atRamp ??= { p: base, ts: ts };
  console.log(`preço em closeMs (último tick até ${iso(closeMs)}): ${atClose ? `${atClose.p} @ ${iso(atClose.ts)}` : '-'}`);

  // Settlement: poll until the worker settles it.
  let order = null;
  const settleDeadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const { rows } = await db.query(`select status, close_price::text as close_price, settled_at from orders where id = $1`, [orderId]);
    order = rows[0];
    if (order.status !== 'open' || Date.now() >= settleDeadline) break;
    await sleep(POLL_MS);
  }
  const { rows: ledger } = await db.query(`select kind, delta_cents::int as delta, balance_after::int as balance_after from ledger where order_id = $1`, [orderId]);
  const expectedPayout = STAKE_CENTS + Math.floor((STAKE_CENTS * asset.payout_pct) / 100);
  const payout = ledger.find((l) => l.kind === 'payout');

  // Candle from snapshots.
  const { rows: candle } = await db.query(
    `select date_bin('60 seconds', captured_at, 'epoch'::timestamptz) as bucket,
            (array_agg(price::text order by captured_at desc))[1] as close,
            max(captured_at) as last_at, count(*)::int as n
       from price_snapshots
      where asset_id = $1 and captured_at >= $2 and captured_at <= $3
      group by 1 order by 1 desc limit 1`,
    [asset.id, new Date(openMs), new Date(closeMs)],
  );
  const c = candle[0] ?? null;
  // Snapshots in the hold window (stale symbols are skipped by the relay).
  const { rows: holdSnaps } = await db.query(
    `select price::text as price, captured_at from price_snapshots
      where asset_id = $1 and captured_at >= $2 and captured_at <= $3 order by captured_at`,
    [asset.id, new Date(closeMs - HOLD_MS), new Date(closeMs)],
  );
  const holdOk = holdSnaps.length >= HOLD_SNAPSHOTS_MIN && holdSnaps.every((s) => onTarget(s.price, target));

  // Smooth return: sample at 50% and 90% of the release, and the largest step seen.
  const sampleAt = (frac) => {
    if (releaseDist.length === 0) return null;
    const want = ov.closeMs + ov.releaseMs * frac;
    return releaseDist.reduce((best, s) => (Math.abs(s.at - want) < Math.abs(best.at - want) ? s : best));
  };
  const mid = sampleAt(0.5);
  const late = sampleAt(0.9);
  const reachedOk = minDistInHold <= gap * 0.01;
  const midOk = reachedOk && mid !== null && mid.dist >= gap * 0.3;
  const lateOk = reachedOk && late !== null && late.dist >= gap * 0.85;
  // j: the k each release tick used, k_eff = (p − from) / (real − from), against smoothstep at its rt.
  // The market cancels out and no clock difference matters. `from` is the hold's price at the close (the
  // relay's releaseFrom); without it, the first release tick.
  const kFromClose = atClose ? Number(atClose.p) : null;
  const kFrom = kFromClose ?? releaseTicks[0]?.p ?? null;
  const kFromSrc = kFromClose !== null ? 'preço em closeMs' : 'FALLBACK: 1ª amostra da volta (sem atClose)';
  let kWorstDev = null;
  let kWorstBack = 0;
  let kValid = 0;
  let kBiasSum = 0;
  let prevK = null;
  let lastK = null;
  // From the close every release tick is checked; with the fallback the first one is `from` itself.
  for (const s of kFromClose !== null ? releaseTicks : releaseTicks.slice(1)) {
    if (kFrom === null || s.real === null || Math.abs(s.real - kFrom) < gap * RELEASE_K_ROOT_FRAC) continue;
    const kEff = (s.p - kFrom) / (s.real - kFrom);
    const tExp = Math.min(1, Math.max(0, (s.rt - ov.closeMs) / ov.releaseMs));
    const kExp = tExp * tExp * (3 - 2 * tExp);
    const dev = kEff - kExp;
    kValid++;
    kBiasSum += dev;
    if (kWorstDev === null || Math.abs(dev) > Math.abs(kWorstDev.dev)) kWorstDev = { dev, kEff, kExp, at: s.rt };
    if (prevK !== null) kWorstBack = Math.max(kWorstBack, prevK - kEff);
    prevK = kEff;
    lastK = { kEff, at: s.rt };
  }
  const gaps = releaseTicks.slice(1).map((s, i) => s.rt - releaseTicks[i].rt);
  const stalls = gaps.filter((g) => g > RELEASE_STALL_MS).length;
  const meanTickMs = gaps.length ? gaps.reduce((a, g) => a + g, 0) / gaps.length : null;
  const stepOk = kValid > 5 && Math.abs(kWorstDev.dev) <= RELEASE_K_TOL && kWorstBack <= RELEASE_K_BACK;

  // OTC: the generator eases exponentially (τ = release/3) to the shadow price, which px carries as
  // realPrice. It is checked by convergence, not by the shape of the curve.
  const releaseEndMs = ov.closeMs + ov.releaseMs;
  const otcLast = [...releaseTicks].reverse().find((s) => s.rt < releaseEndMs && s.real !== null) ?? null;
  const otcLastGap = otcLast ? Math.abs(otcLast.p - otcLast.real) : null;
  const otcEndOk = reachedOk && otcLastGap !== null && otcLastGap <= gap * OTC_RELEASE_END_FRAC;
  const otcInside = releaseTicks.filter((s) => s.rt > ov.closeMs && s.rt < releaseEndMs).length;
  const otcKOk = kValid >= 1 && kWorstBack <= RELEASE_K_BACK && lastK !== null && lastK.kEff >= OTC_RELEASE_K_MIN;

  const backBase = afterRelease ? pctGap(afterRelease.p, base) : null;
  /** OTC: the last release tick (it still has ov, so realPrice = the shadow) against its own shadow. */
  const otcBackShadow = otcLast ? pctGap(otcLast.p, otcLast.real) : null;
  const backRamp = afterRelease ? pctGap(afterRelease.p, atRamp.p) : null;
  const results = [
    ['a', `preço em closeMs ${eqLabel}`, onTarget(atClose?.p, target), `${atClose?.p ?? '-'} vs ${target}`],
    [
      'b',
      `close do candle (snapshots) ${eqLabel}`,
      onTarget(c?.close, target),
      c ? `${c.close} @ ${c.last_at.toISOString()} (bucket ${c.bucket.toISOString()}, ${c.n} snapshots)` : 'sem snapshots',
    ],
    ['c', "ordem status='won'", order?.status === 'won', `status=${order?.status}`],
    ['d', `close_price ${eqLabel}`, onTarget(order?.close_price, target), `close_price=${order?.close_price ?? '-'}`],
    [
      'e',
      'ledger com payout',
      payout?.delta === expectedPayout,
      payout ? `payout ${payout.delta} (esperado ${expectedPayout}), saldo ${payout.balance_after}` : `nenhum payout (ledger: ${JSON.stringify(ledger)})`,
    ],
    [
      'f',
      market
        ? `preço < ${String(BACK_MAX_PCT).replace('.', ',')}% do base em closeMs+release`
        : `preço < ${String(BACK_MAX_PCT).replace('.', ',')}% da sombra (realPrice) no último tick da volta`,
      market ? backBase !== null && backBase < BACK_MAX_PCT : otcBackShadow !== null && otcBackShadow < BACK_MAX_PCT,
      market
        ? afterRelease
          ? `${afterRelease.p} @ ${iso(afterRelease.ts)}: ${backBase.toFixed(4)}% do base ${base}, ${backRamp.toFixed(4)}% do preço no início da rampa ${atRamp.p}`
          : 'sem tick após o release'
        : otcLast
          ? `p=${otcLast.p.toFixed(d)} em t=${((otcLast.rt - ov.closeMs) / 1000).toFixed(2)} s: ${otcBackShadow.toFixed(4)}% da sombra realPrice=${otcLast.real.toFixed(d)} (base ${base}, ${backBase === null ? '-' : backBase.toFixed(4)}% dele após a volta)`
          : 'sem tick com realPrice dentro da volta',
    ],
    [
      'g',
      `≥ ${HOLD_SNAPSHOTS_MIN} snapshots no hold, todos ${eqLabel}`,
      holdOk,
      `${holdSnaps.length}: ${holdSnaps.map((s) => `${s.price}@${s.captured_at.toISOString()}`).join(', ') || 'NENHUM (símbolo stale?)'}`,
    ],
    market
      ? [
          'h',
          `volta gradual: longe do alvo na metade (≥30% de ${gap.toFixed(d)})`,
          midOk,
          mid ? `${(mid.dist / gap * 100).toFixed(1)}% da distância percorrida em ${((mid.at - ov.closeMs) / 1000).toFixed(1)} s` : 'sem amostras',
        ]
      : ['h', 'volta gradual na metade', null, 'N/A: OTC usa exponencial; ver i e j'],
    market
      ? ['i', 'volta quase no fim em 90% do release', lateOk, late ? `distância ${late.dist.toFixed(d)} (${(late.dist / gap * 100).toFixed(1)}%)` : 'sem amostras']
      : [
          'i',
          `no fim da volta, |p − sombra| ≤ ${OTC_RELEASE_END_FRAC * 100}% da distância (${(gap * OTC_RELEASE_END_FRAC).toFixed(d)})`,
          otcEndOk,
          otcLast
            ? `último tick da volta em t=${((otcLast.rt - ov.closeMs) / 1000).toFixed(2)} s: p=${otcLast.p.toFixed(d)}, sombra=${otcLast.real.toFixed(d)}, |p − sombra|=${otcLastGap.toFixed(d)} (${((otcLastGap / gap) * 100).toFixed(1)}%)`
            : 'sem tick com realPrice dentro da volta',
        ],
    market
      ? [
        'j',
        `k da volta segue o smoothstep (|k_eff − k_exp| ≤ ${RELEASE_K_TOL}, recuo ≤ ${RELEASE_K_BACK})`,
        stepOk,
        kWorstDev
          ? `pior desvio ${kWorstDev.dev >= 0 ? '+' : ''}${kWorstDev.dev.toFixed(4)} (k_eff ${kWorstDev.kEff.toFixed(4)} vs k_exp ${kWorstDev.kExp.toFixed(4)} em t=${((kWorstDev.at - ov.closeMs) / 1000).toFixed(1)} s), ` +
            `from=${kFrom} (${kFromSrc}), recuo ${kWorstBack.toFixed(4)}, viés médio ${(kBiasSum / kValid >= 0 ? '+' : '')}${(kBiasSum / kValid).toFixed(4)}, ${kValid} amostras válidas de ${kFromClose !== null ? releaseTicks.length : Math.max(0, releaseTicks.length - 1)}; ` +
            `stalls=${stalls} (rt > ${RELEASE_STALL_MS} ms), espaçamento médio ${meanTickMs === null ? '-' : Math.round(meanTickMs)} ms`
          : `sem amostras válidas (${releaseTicks.length} ticks no release, ${releaseTicks.filter((s) => s.real !== null).length} com realPrice, from=${kFrom ?? '-'} (${kFromSrc}))`,
      ]
      : [
          'j',
          `exponencial converge: k_eff nunca recua > ${RELEASE_K_BACK} e chega a ≥ ${OTC_RELEASE_K_MIN} no último tick da volta`,
          otcKOk,
          lastK
            ? `último k_eff ${lastK.kEff.toFixed(4)} em t=${((lastK.at - ov.closeMs) / 1000).toFixed(2)} s, recuo ${kWorstBack.toFixed(4)}, from=${kFrom} (${kFromSrc}), ` +
              `${kValid} amostras válidas, ${otcInside} tick(s) dentro da volta de ${ov.releaseMs} ms; stalls=${stalls}, espaçamento médio ${meanTickMs === null ? '-' : Math.round(meanTickMs)} ms`
            : `sem amostras válidas (${releaseTicks.length} ticks no release, ${otcInside} dentro da volta, from=${kFrom ?? '-'})`,
        ],
    [
      'k',
      'preço chegou ao alvo (o override agiu)',
      reachedOk,
      `menor distância ${Number.isFinite(minDistInHold) ? minDistInHold.toFixed(d) : 'sem amostras'} entre rampStartMs e closeMs (limite ${(gap * 0.01).toFixed(d)}, 1% de ${gap.toFixed(d)})`,
    ],
  ];

  console.log('\n================ RELATÓRIO ================');
  console.log(
    `modo=${args.dir}${args.early ? ' --early' : ''}${args.unlimited ? ' --unlimited' : ''} ativo=${asset.symbol} (${asset.kind}) base=${base} alvo=${target} candle=${iso(openMs)}→${iso(closeMs)}`,
  );
  console.log(`antecedência gravação→rampStartMs: ${((ov.rampStartMs - ov.writtenAtMs) / 1000).toFixed(1)} s`);
  console.log(`wire id=${ov.id} (os ticks marcados com esse ov trazem realPrice no px)`);
  console.log(`hold=${HOLD_MS} ms release=${ov.releaseMs} ms rampa=${rampMs} ms min_lead=${MIN_LEAD_MS} ms`);
  console.log(`modelo=${market ? 'smoothstep (mercado)' : 'exponencial (OTC)'}`);
  console.log(
    `jitter=${args.jitter ? 'ligado' : 'desligado'} banda=${args.jitter ? `±${band.toFixed(d)} (10% de ${gap.toFixed(d)}, piso 2 ticks; tolerância +${(tick / 2).toFixed(d + 1)})` : 'n/a (comparação exata)'}`,
  );
  console.log(`ordem=${orderId} settled_at=${order?.settled_at?.toISOString?.() ?? '-'}`);
  for (const [id, name, ok, detail] of results) console.log(`(${id}) ${ok === null ? 'N/A ' : ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`);
  console.log('--- diagnóstico ---');
  console.log(`ws aplicou o override: ${wsLine ? 'sim' : args.wsLog ? 'NÃO' : 'não verificado'}`);
  console.log(`TTL da chave em closeMs: ${pttlAtClose} ms; chave sumiu antes do release: ${keyGoneEarlyAt ? iso(keyGoneEarlyAt) : 'não'}`);
  const failed = results.filter((r) => r[2] === false).length;
  console.log(failed === 0 ? 'RESULTADO: PASS' : `RESULTADO: FAIL (${failed} critério(s))`);
  return failed === 0 ? 0 : 1;
}

// ---------- main ----------

loadDotEnv();
const args = parseArgs(process.argv.slice(2));
if (!process.env.DATABASE_URL || !process.env.REDIS_URL) die('DATABASE_URL e REDIS_URL são obrigatórios (.env ou ambiente)');
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
let code = 0;
let stopWorker = async () => {};
try {
  if (args.clean) await clean(db, redis);
  else if (args.watch) await watch(db, redis, args);
  else {
    stopWorker = await ensureWorker();
    code = await run(db, redis, args);
  }
} catch (err) {
  console.error(err);
  code = 2;
} finally {
  await stopWorker();
  await db.end();
  redis.disconnect();
}
process.exit(code);
