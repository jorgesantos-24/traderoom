// Manual end-to-end check of the OTC price override (no UI, no admin routes).
//
//   node tests/manual/otc-override.mjs [--symbol BTCOTC] [--up|--down] [--target 75900.00] [--early] [--ws-log ws.log]
//     --early: writes the override right after the candle opens (~50 s before the ramp) instead of just before it.
//   node tests/manual/otc-override.mjs --watch [--symbol BTCOTC] [--up|--down|--target X]
//   node tests/manual/otc-override.mjs --clean
//
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
  OTC_OVERRIDE_MIN_LEAD_MS as MIN_LEAD_MS,
  OTC_OVERRIDE_RAMP_DEFAULT_MS as RAMP_MS,
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
  const a = { symbol: 'BTCOTC', dir: 'up', target: null, watch: false, clean: false, early: false, wsLog: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--symbol') a.symbol = String(argv[++i] ?? '').toUpperCase();
    else if (k === '--up') a.dir = 'up';
    else if (k === '--down') a.dir = 'down';
    else if (k === '--target') a.target = argv[++i];
    else if (k === '--watch') a.watch = true;
    else if (k === '--clean') a.clean = true;
    else if (k === '--early') a.early = true;
    else if (k === '--ws-log') a.wsLog = argv[++i];
    else die(`argumento desconhecido: ${k}`);
  }
  if (a.target !== null && !(Number(a.target) > 0)) die(`--target inválido: ${a.target}`);
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
  const { rows } = await db.query(`select id, symbol, kind, enabled, payout_pct, otc_decimals from assets where symbol = $1`, [symbol]);
  const a = rows[0];
  if (!a) die(`ativo ${symbol} não existe em assets`);
  if (a.kind !== 'otc') die(`ativo ${symbol} não é OTC (kind=${a.kind})`);
  if (!a.enabled) die(`ativo ${symbol} está desabilitado`);
  return a;
}

async function readPx(redis, symbol) {
  const raw = await redis.get(RedisKeys.price(symbol));
  if (!raw) return null;
  const r = JSON.parse(raw);
  return { p: String(r.p), ts: Number(r.ts) };
}

/**
 * Candle with at least MIN_LEAD_MS left (else the next one).
 * - 'near-ramp': waits until just before the ramp, so base is the price the ramp starts from.
 * - 'early': waits for the next candle to open and writes right after the turnover (~50 s of lead).
 * - 'now': writes immediately.
 */
async function pickCandle(mode) {
  let now = Date.now();
  if (mode === 'early') {
    const next = (Math.floor(now / CANDLE_MS) + 1) * CANDLE_MS;
    console.log(`--early: aguardando a virada (${next - now} ms) para gravar logo que o candle abrir`);
    await sleep(next - now + 100);
    now = Date.now();
    const open = Math.floor(now / CANDLE_MS) * CANDLE_MS;
    return { openMs: open, closeMs: open + CANDLE_MS };
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
  const writeAt = otcOverrideRampStartMs(0, closeMs, RAMP_MS) - WRITE_BEFORE_RAMP_MS;
  if (mode === 'near-ramp' && writeAt > now) {
    console.log(`aguardando ${writeAt - now} ms para gravar o override logo antes da rampa`);
    await sleep(writeAt - now);
  }
  return { openMs: open, closeMs };
}

function pickTarget(args, base, decimals) {
  if (args.target !== null) return Number(args.target).toFixed(decimals);
  return (Number(base) * (args.dir === 'down' ? 0.998 : 1.002)).toFixed(decimals);
}

async function writeOverride(redis, symbol, target, base, closeMs) {
  const now = Date.now();
  const payload = {
    symbol,
    targetPrice: target,
    basePrice: base,
    closeMs,
    rampStartMs: otcOverrideRampStartMs(now, closeMs, RAMP_MS),
    holdMs: HOLD_MS,
    releaseMs: RELEASE_MS,
  };
  const ttl = closeMs + RELEASE_MS - now + 10_000;
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
  const px = await readPx(redis, asset.symbol);
  if (!px) die(`sem preço em px:${asset.symbol}; o ws (npm run dev:ws) está rodando?`);
  const { closeMs } = await pickCandle(args.early ? 'early' : 'now');
  const target = pickTarget(args, px.p, asset.otc_decimals);
  const ov = await writeOverride(redis, asset.symbol, target, px.p, closeMs);
  await waitWsApplied(args.wsLog, closeMs);
  console.log(`abra /traderoom, ${asset.symbol}, intervalo 1m. Candle fecha em ${iso(closeMs)} em ${target}.`);
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    const now = Date.now();
    const cur = await readPx(redis, asset.symbol);
    const dist = cur ? (Number(cur.p) - Number(target)).toFixed(asset.otc_decimals) : '-';
    console.log(`${iso(now)}  px=${cur?.p ?? '-'}  alvo-dist=${dist}  fase=${phaseAt(now, ov)}`);
    await sleep(POLL_MS - (Date.now() - now));
  }
}

async function run(db, redis, args) {
  const asset = await loadAsset(db, args.symbol);
  const d = asset.otc_decimals;
  const { rows: cols } = await db.query(
    `select table_name, column_name from information_schema.columns
      where table_schema = 'public' and table_name in ('orders', 'accounts')`,
  );
  const hasOrderAccount = cols.some((c) => c.table_name === 'orders' && c.column_name === 'account');
  const hasAccountKind = cols.some((c) => c.table_name === 'accounts' && c.column_name === 'kind');
  if (!(await readPx(redis, asset.symbol))) die(`sem preço em px:${asset.symbol}; o ws (npm run dev:ws) está rodando?`);

  const { openMs, closeMs } = await pickCandle(args.early ? 'early' : 'near-ramp');
  const px = await readPx(redis, asset.symbol);
  if (!px) die(`sem preço em px:${asset.symbol}; o ws (npm run dev:ws) está rodando?`);
  const base = px.p;
  const target = pickTarget(args, base, d);
  const up = Number(target) > Number(base);
  if (Number(target) === Number(base)) die('alvo igual ao preço atual; a ordem empataria');
  console.log(`ativo ${asset.symbol} id=${asset.id} decimals=${d} payout=${asset.payout_pct}%`);
  console.log(`candle ${iso(openMs)} → ${iso(closeMs)}; base=${base} alvo=${target} (${up ? 'call' : 'put'})`);

  // User, account, order.
  const ts = Date.now();
  const email = `${EMAIL_PREFIX}${ts}${EMAIL_DOMAIN}`;
  const { rows: urows } = await db.query(`insert into users (email, password_hash, name, role) values ($1, $2, $3, 'user') returning id`, [
    email,
    PASSWORD_HASH,
    `OTC override ${ts}`,
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
  console.log(`usuário ${email} (${userId}), ordem ${orderId}`);

  const ov = await writeOverride(redis, asset.symbol, target, base, closeMs);
  const wsLine = await waitWsApplied(args.wsLog, closeMs);
  if (args.wsLog && !wsLine) die('o ws não registrou "otc override applied" em 3 s; abortando');

  // Price polling until the first tick at or after the end of the release.
  let atClose = null; // newest tick with ts <= closeMs
  let atRamp = null; // newest tick before the ramp: where the natural path was when the ramp took over
  let afterRelease = null; // first tick with ts >= closeMs + releaseMs
  let pttlAtClose = null;
  let keyGoneEarlyAt = null;
  const releaseEnd = closeMs + RELEASE_MS;
  const giveUp = releaseEnd + 5000;
  while (!afterRelease && Date.now() < giveUp) {
    const now = Date.now();
    const cur = await readPx(redis, asset.symbol);
    if (cur) {
      if (cur.ts < ov.rampStartMs && (!atRamp || cur.ts > atRamp.ts)) atRamp = cur;
      if (cur.ts <= closeMs && (!atClose || cur.ts > atClose.ts)) atClose = cur;
      if (cur.ts >= releaseEnd) afterRelease = cur;
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
  const holdOk = holdSnaps.length >= HOLD_SNAPSHOTS_MIN && holdSnaps.every((s) => same(s.price, target, d));

  const backBase = afterRelease ? pctGap(afterRelease.p, base) : null;
  const backRamp = afterRelease ? pctGap(afterRelease.p, atRamp.p) : null;
  const results = [
    ['a', 'preço em closeMs == alvo', same(atClose?.p, target, d), `${atClose?.p ?? '-'} vs ${target}`],
    [
      'b',
      'close do candle (snapshots) == alvo',
      same(c?.close, target, d),
      c ? `${c.close} @ ${c.last_at.toISOString()} (bucket ${c.bucket.toISOString()}, ${c.n} snapshots)` : 'sem snapshots',
    ],
    ['c', "ordem status='won'", order?.status === 'won', `status=${order?.status}`],
    ['d', 'close_price == alvo', same(order?.close_price, target, d), `close_price=${order?.close_price ?? '-'}`],
    [
      'e',
      'ledger com payout',
      payout?.delta === expectedPayout,
      payout ? `payout ${payout.delta} (esperado ${expectedPayout}), saldo ${payout.balance_after}` : `nenhum payout (ledger: ${JSON.stringify(ledger)})`,
    ],
    [
      'f',
      `preço < ${String(BACK_MAX_PCT).replace('.', ',')}% do base em closeMs+release`,
      backBase !== null && backBase < BACK_MAX_PCT,
      afterRelease
        ? `${afterRelease.p} @ ${iso(afterRelease.ts)}: ${backBase.toFixed(4)}% do base ${base}, ${backRamp.toFixed(4)}% do preço no início da rampa ${atRamp.p}`
        : 'sem tick após o release',
    ],
    [
      'g',
      `≥ ${HOLD_SNAPSHOTS_MIN} snapshots no hold, todos == alvo`,
      holdOk,
      `${holdSnaps.length}: ${holdSnaps.map((s) => `${s.price}@${s.captured_at.toISOString()}`).join(', ') || 'NENHUM (símbolo stale?)'}`,
    ],
  ];

  console.log('\n================ RELATÓRIO ================');
  console.log(`modo=${args.dir}${args.early ? ' --early' : ''} ativo=${asset.symbol} base=${base} alvo=${target} candle=${iso(openMs)}→${iso(closeMs)}`);
  console.log(`antecedência gravação→rampStartMs: ${((ov.rampStartMs - ov.writtenAtMs) / 1000).toFixed(1)} s`);
  console.log(`hold=${HOLD_MS} ms release=${RELEASE_MS} ms rampa=${RAMP_MS} ms min_lead=${MIN_LEAD_MS} ms`);
  console.log(`ordem=${orderId} settled_at=${order?.settled_at?.toISOString?.() ?? '-'}`);
  for (const [id, name, ok, detail] of results) console.log(`(${id}) ${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`);
  console.log('--- diagnóstico ---');
  console.log(`ws aplicou o override: ${wsLine ? 'sim' : args.wsLog ? 'NÃO' : 'não verificado'}`);
  console.log(`TTL da chave em closeMs: ${pttlAtClose} ms; chave sumiu antes do release: ${keyGoneEarlyAt ? iso(keyGoneEarlyAt) : 'não'}`);
  const failed = results.filter((r) => !r[2]).length;
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
