// Requires `npm run dev:deps` and `npm run db:migrate` first.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import {
  OTC_OVERRIDE_HOLD_MS,
  OTC_OVERRIDE_LANDING_MS,
  OTC_OVERRIDE_MIN_LEAD_MS,
  OTC_OVERRIDE_RAMP_DEFAULT_MS,
  OTC_OVERRIDE_RELEASE_MS,
  OTC_OVERRIDE_SCHEDULE_HORIZON_MS,
  OtcOverrideInput,
  parseOtcOverride,
  RedisKeys,
  Registry,
  type OtcOverrideState,
  type PriceRecord,
} from '@traderoom/shared';
// The real generator, driven by the wire this API writes: the same code the ws runs.
import { OtcFeed, OtcWalk } from '../../ws/src/feed/otc.js';
import { BAND_FRACTION } from '../../ws/src/feed/override-path.js';
import { PriceOverride } from '../../ws/src/feed/price-override.js';
import { insertSnapshots, loadOverrideTarget, saveOverrideTarget, toPriceRecord, type SnapshotRow } from '../../ws/src/feed/sinks.js';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/lib/errors.js';
import { createPool } from '../src/lib/db.js';
import { createRedis } from '../src/lib/redis.js';
import { createAssetRepo } from '../src/services/assets.js';
import { createAuthService } from '../src/services/auth.js';
import { createOrderLimitsRepo } from '../src/services/order-limits.js';
import { createOrderService, redisDueScheduler, redisPriceReader } from '../src/services/orders.js';
import { createOtcOverrideService, type OtcOverrideService } from '../src/services/otc-override.js';
import { settleOrder } from '../src/services/settlement.js';
import { CookieJar, testApp } from './helpers.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const DOMAIN = 'otc-override-int.traderoom.test';
const RUN = randomUUID()
  .slice(0, 6)
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, 'X');
const OTC_A = `ZZOVA${RUN}`;
const OTC_B = `ZZOVB${RUN}`;
const MARKET = `ZZOVM${RUN}USDT`;
/**
 * A market asset set up for overrides by the column defaults (price_decimals 2, max_override_pct 0.1%).
 * price_decimals stays nullable on purpose: an explicit NULL is how an asset is kept out of overrides.
 */
const MKT = `ZZOVP${RUN}USDT`;
const QUEUE = `orders:due:test-otc-override-${RUN}`;
/** Own key: a ws running on this machine keeps reading the real one. */
const KEY = `otc:override:test:${RUN}`;
const RL_NS = `rl-otc-override-int-${RUN}:`;
const PASSWORD = 'senha-forte-123';
const MIN = 60_000;

let pool: pg.Pool;
let redis: Redis;
let adminId: string;
const ids: Record<'a' | 'b' | 'market' | 'mkt', number> = { a: 0, b: 0, market: 0, mkt: 0 };
/** A minute boundary an hour ago: settlement only cares about relative times. */
const T0 = Math.floor(Date.now() / MIN) * MIN - 3_600_000;
let clock = T0;
let svc: OtcOverrideService;

const input = (o: Partial<OtcOverrideInput> & Pick<OtcOverrideInput, 'assetId' | 'targetPrice'>) =>
  OtcOverrideInput.parse({ interval: '1m', ...o });

async function setPrice(symbol: string, p: string): Promise<void> {
  await redis.set(RedisKeys.price(symbol), JSON.stringify({ p, ts: clock, rt: clock, src: 'otc' }), 'PX', 600_000);
}

async function newUser(name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(`insert into users (email, password_hash, name) values ($1, '!', $2) returning id`, [
    `u-${randomUUID()}@${DOMAIN}`,
    name,
  ]);
  return rows[0]?.id ?? '';
}

async function expectAppError(p: Promise<unknown>, status: number, message?: RegExp): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  const e = err as AppError;
  expect(e.statusCode).toBe(status);
  if (message) expect(e.message).toMatch(message);
  return e;
}

beforeAll(async () => {
  pool = createPool(config);
  redis = createRedis(config);
  svc = createOtcOverrideService({ pool, redis, now: () => clock, key: KEY });
  const otc = `insert into assets (symbol, display, kind, payout_pct, enabled, sort, otc_start_price, otc_vol_pct_hour, otc_decimals)
               values ($1, $2, 'otc', 90, true, 9990, 100, 0.8, 2) returning id`;
  ids.a = (await pool.query<{ id: number }>(otc, [OTC_A, 'Teste A (OTC)'])).rows[0]?.id ?? 0;
  ids.b = (await pool.query<{ id: number }>(otc, [OTC_B, 'Teste B (OTC)'])).rows[0]?.id ?? 0;
  ids.market =
    (
      await pool.query<{ id: number }>(
        // No decimals on purpose: the asset an override must refuse.
        `insert into assets (symbol, display, binance_stream, payout_pct, enabled, sort, price_decimals) values ($1, 'Teste M', $2, 80, true, 9991, null) returning id`,
        [MARKET, `${MARKET.toLowerCase()}@trade`],
      )
    ).rows[0]?.id ?? 0;
  ids.mkt =
    (
      await pool.query<{ id: number }>(
        // Created like any new market asset: price_decimals and max_override_pct come from the defaults.
        `insert into assets (symbol, display, binance_stream, payout_pct, enabled, sort) values ($1, 'Teste P', $2, 80, true, 9992) returning id`,
        [MKT, `${MKT.toLowerCase()}@trade`],
      )
    ).rows[0]?.id ?? 0;
  adminId = await newUser('Admin OTC');
  // A leftover active override (from a crashed run or the dev UI) would make every test 409.
  const active = await pool.query<{ symbol: string }>(
    `select a.symbol from otc_overrides o join assets a on a.id = o.asset_id where o.active`,
  );
  if (active.rows[0]) throw new Error(`an OTC override is active (${active.rows[0].symbol}); release it before running this suite`);
});

afterEach(async () => {
  await svc.release(adminId);
  clock = T0;
});

afterAll(async () => {
  const assetIds = [ids.a, ids.b, ids.market, ids.mkt];
  const users = `select id from users where email like '%@${DOMAIN}'`;
  await pool.query(`delete from admin_audit where admin_id in (${users})`);
  await pool.query(`delete from ledger where user_id in (${users})`);
  await pool.query(`delete from orders where user_id in (${users})`);
  await pool.query('delete from orders where asset_id = any($1)', [assetIds]);
  await pool.query('delete from otc_overrides where asset_id = any($1)', [assetIds]);
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`]);
  await pool.query('delete from price_snapshots where asset_id = any($1)', [assetIds]);
  await pool.query('delete from assets where id = any($1)', [assetIds]);
  await redis.del(KEY, QUEUE, RedisKeys.price(OTC_A), RedisKeys.price(OTC_B), RedisKeys.price(MKT));
  await pool.end();
  redis.disconnect();
});

describe('apply', () => {
  it('writes the row, the audit and the Redis wire for the current candle', async () => {
    clock = T0 + 20_000;
    await setPrice(OTC_A, '100.00');
    const v = await svc.apply(adminId, input({ assetId: ids.a, targetPrice: 101.234 }));
    expect(v).toMatchObject({
      symbol: OTC_A,
      targetPrice: 101.23,
      basePrice: 100,
      candleOpenMs: T0,
      candleCloseMs: T0 + MIN,
      phase: 'ramp',
    });
    expect(v.rampStartMs).toBe(T0 + MIN - OTC_OVERRIDE_HOLD_MS - OTC_OVERRIDE_LANDING_MS - OTC_OVERRIDE_RAMP_DEFAULT_MS);

    const wire = parseOtcOverride(await redis.get(KEY));
    expect(wire).toEqual({
      id: v.id,
      symbol: OTC_A,
      targetPrice: '101.23',
      basePrice: '100.00',
      closeMs: T0 + MIN,
      rampStartMs: v.rampStartMs,
      holdMs: OTC_OVERRIDE_HOLD_MS,
      releaseMs: OTC_OVERRIDE_RELEASE_MS,
    });
    // TTL is computed from the service clock (an hour ago), so it is already past; check the formula instead.
    const { rows } = await pool.query<{ action: string; payload: Record<string, unknown> }>(
      `select action, payload from admin_audit where admin_id = $1 order by id desc limit 1`,
      [adminId],
    );
    expect(rows[0]).toMatchObject({ action: 'otc.override', payload: { symbol: OTC_A, targetPrice: '101.23', basePrice: '100.00' } });

    const state = await svc.get();
    expect(state.override?.id).toBe(v.id);
    expect(state.assets.map((a) => a.symbol)).toEqual(expect.arrayContaining([OTC_A, OTC_B]));
    expect(state.assets.map((a) => a.symbol)).not.toContain(MARKET);
  });

  it('409 while another asset holds the single slot', async () => {
    clock = T0 + 10_000;
    await setPrice(OTC_A, '100.00');
    await setPrice(OTC_B, '100.00');
    await svc.apply(adminId, input({ assetId: ids.a, targetPrice: 101 }));
    await expectAppError(
      svc.apply(adminId, input({ assetId: ids.b, targetPrice: 99 })),
      409,
      new RegExp(`Já existe um override ativo \\(ativo ${OTC_A}, faltam 50s\\)`),
    );
    // The rejected attempt left nothing behind.
    expect(parseOtcOverride(await redis.get(KEY))?.symbol).toBe(OTC_A);
  });

  it('400 for a market asset with no price_decimals, 404 for an unknown one', async () => {
    await expectAppError(svc.apply(adminId, input({ assetId: ids.market, targetPrice: 50 })), 400, /casas decimais/);
    await expectAppError(svc.apply(adminId, input({ assetId: 2_000_000_000, targetPrice: 50 })), 404);
  });

  it('409 without a current price', async () => {
    await redis.del(RedisKeys.price(OTC_B));
    await expectAppError(svc.apply(adminId, input({ assetId: ids.b, targetPrice: 99 })), 409, /Sem cotação/);
  });

  it('too close to the close: 409 with the time left; nextCandle uses the following candle', async () => {
    clock = T0 + 56_500;
    await setPrice(OTC_A, '100.00');
    await expectAppError(svc.apply(adminId, input({ assetId: ids.a, targetPrice: 101 })), 409, /Faltam 3,5 s/);
    const v = await svc.apply(adminId, input({ assetId: ids.a, targetPrice: 101, nextCandle: true }));
    expect(v.candleOpenMs).toBe(T0 + MIN);
    expect(v.candleCloseMs).toBe(T0 + 2 * MIN);
    expect(v.rampStartMs).toBe(T0 + 2 * MIN - OTC_OVERRIDE_HOLD_MS - OTC_OVERRIDE_LANDING_MS - OTC_OVERRIDE_RAMP_DEFAULT_MS);
    expect(parseOtcOverride(await redis.get(KEY))?.closeMs).toBe(T0 + 2 * MIN);
  });

  it('a finished override frees the slot by itself; release clears row and key', async () => {
    clock = T0 + 30_000;
    await setPrice(OTC_A, '100.00');
    const first = await svc.apply(adminId, input({ assetId: ids.a, targetPrice: 101 }));
    clock = first.releaseEndMs;
    expect((await svc.get()).override).toBeNull();
    clock = T0 + MIN + 30_000;
    await setPrice(OTC_B, '100.00');
    const second = await svc.apply(adminId, input({ assetId: ids.b, targetPrice: 99 }));
    expect(second.symbol).toBe(OTC_B);
    expect(await svc.release(adminId)).toBe(true);
    expect(await redis.get(KEY)).toBeNull();
    expect(await svc.release(adminId)).toBe(false);
    const { rows } = await pool.query<{ active: boolean; ended_at: Date | null }>(
      'select active, ended_at from otc_overrides where id = $1',
      [second.id],
    );
    expect(rows[0]).toMatchObject({ active: false });
    expect(rows[0]?.ended_at).not.toBeNull();
  });
});

/**
 * The OTC hold wobbles around the target within BAND_FRACTION of the body (target − price at the ramp
 * start). The ramp starts near 100.00; 0.01 covers that drift and the rounding.
 */
function inBand(price: string | undefined, target: number, from = 100): boolean {
  return price !== undefined && Math.abs(Number(price) - target) <= BAND_FRACTION * Math.abs(target - from) + 0.01 + 1e-9;
}

describe('settlement on the forced close', () => {
  /** Seeded normals, so the natural part of the path is noisy but repeatable. */
  function seeded(seed: number) {
    let s = seed >>> 0 || 1;
    const u = () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return ((s >>> 0) + 1) / 4294967297;
    };
    return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  }

  /**
   * One order expiring at the forced close, priced by the ws generator and its 1 s snapshots.
   * `jitter: false` drives the legacy path (flat hold on the exact target), which the wire can still select.
   */
  async function settleAtClose(dir: 'call' | 'put', target: number, seed: number, jitter?: false) {
    clock = T0 + 15_000;
    await setPrice(OTC_A, '100.00');
    const v = await svc.apply(adminId, input({ assetId: ids.a, targetPrice: target }));
    const stored = parseOtcOverride(await redis.get(KEY));
    expect(stored).not.toBeNull();
    const wire = stored && jitter === false ? { ...stored, jitter } : stored;

    const user = await newUser(`Cliente ${dir}`);
    await pool.query(`insert into accounts (user_id, kind, balance_cents) values ($1, 'real', 100000)`, [user]);
    const { rows } = await pool.query<{ id: string }>(
      `insert into orders (user_id, asset_id, direction, stake_cents, payout_pct, duration_sec, open_price, opens_at, expires_at, idempotency_key, account)
       values ($1, $2, $3, 10000, 90, 60, '100.00', $4, $5, $6, 'real') returning id`,
      [user, ids.a, dir, new Date(clock), new Date(v.candleCloseMs), randomUUID()],
    );
    const orderId = rows[0]?.id ?? '';

    // Relay: generator ticks every 500 ms, snapshots every 1 s at an arbitrary phase.
    await pool.query('delete from price_snapshots where asset_id = $1', [ids.a]);
    const walk = new OtcWalk({ startPrice: 100, volPctHour: 0.8, decimals: 2 }, 100, seeded(seed));
    walk.setOverride(wire, clock);
    const snaps: Array<{ price: string; at: Date }> = [];
    let last = clock;
    let price = walk.format();
    const end = v.releaseEndMs + 3000;
    for (let t = clock + 1; t <= end; t++) {
      if ((t - clock) % 500 === 0) {
        price = walk.format(walk.step((t - last) / 1000, t));
        last = t;
      }
      if ((t - clock) % 1000 === 317) snaps.push({ price, at: new Date(t) });
    }
    await pool.query(
      `insert into price_snapshots (asset_id, price, captured_at) select $1, * from unnest($2::numeric[], $3::timestamptz[])`,
      [ids.a, snaps.map((s) => s.price), snaps.map((s) => s.at)],
    );
    const inHold = snaps.filter((s) => s.at.getTime() >= v.holdStartMs && s.at.getTime() <= v.candleCloseMs);
    expect(inHold.length).toBeGreaterThanOrEqual(3);
    for (const s of inHold) {
      if (jitter === false) expect(s.price).toBe(target.toFixed(2));
      else expect(inBand(s.price, target), `hold snapshot ${s.price}`).toBe(true);
    }
    const atExpiry = snaps.filter((s) => s.at.getTime() <= v.candleCloseMs).at(-1);
    if (jitter === false) expect(atExpiry?.price).toBe(target.toFixed(2));

    const r = await settleOrder(pool, orderId, v.candleCloseMs + 1500);
    expect(r).toMatchObject({ kind: 'settled', status: 'won' });
    const { rows: o } = await pool.query<{ status: string; close_price: string }>(
      'select status, close_price::text as close_price from orders where id = $1',
      [orderId],
    );
    // Settled on the snapshot at expiry (within the band of the target; exactly on it without jitter).
    expect(o[0]).toEqual({ status: 'won', close_price: Number(atExpiry?.price).toFixed(8) });
    const { rows: l } = await pool.query<{ kind: string; delta_cents: string }>(
      'select kind, delta_cents from ledger where order_id = $1',
      [orderId],
    );
    expect(l).toEqual([{ kind: 'payout', delta_cents: '19000' }]);

    await svc.release(adminId);
  }

  it('an order expiring at the close settles near the target and wins', async () => {
    await settleAtClose('call', 100.6, 7);
    await settleAtClose('put', 99.4, 8);
  });

  it('jitter: false (legacy path) settles exactly on the target and wins', async () => {
    await settleAtClose('call', 100.6, 9, false);
  });
});

describe('OTC: same disclosure and protection as market assets', () => {
  it('orders opened before the override and during it both settle on the shown price', async () => {
    clock = T0 + 15_000;
    await setPrice(OTC_A, '100.00');
    const v = await svc.apply(adminId, input({ assetId: ids.a, targetPrice: 100.6 }));
    const wire = parseOtcOverride(await redis.get(KEY));
    expect(wire?.id).toBe(v.id);

    // The ws generator, its ticks and snapshots, exactly as the relay builds them.
    const fail = (err: unknown) => {
      throw err;
    };
    const feed = new OtcFeed({ lastPrice: async () => 100, writeHistory: async () => {}, onError: fail });
    await feed.sync([{ id: ids.a, symbol: OTC_A, otc: { startPrice: 100, volPctHour: 0.8, decimals: 2 } }], clock);
    feed.setOverride(wire, clock);
    const start = clock;
    const rows: SnapshotRow[] = [];
    let last = feed.tick(start)[0];
    let during: ReturnType<typeof toPriceRecord> | null = null;
    for (let t = start + 500; t <= v.releaseEndMs + 3000; t += 500) {
      last = feed.tick(t)[0];
      if (!last) throw new Error('no OTC tick');
      if (t < v.rampStartMs || t >= v.releaseEndMs) expect(last.ov).toBeUndefined();
      else expect(last.ov).toBe(v.id);
      if (!during && last.ov && t >= v.holdStartMs - 2000) during = toPriceRecord(last);
      if ((t - start) % 1000 === 500)
        rows.push({ assetId: ids.a, price: last.price, realPrice: last.realPrice ?? null, capturedAt: new Date(t - 183) });
    }
    await pool.query('delete from price_snapshots where asset_id = $1', [ids.a]);
    await insertSnapshots(pool, rows);

    // Snapshots of changed ticks keep the natural price; the others have none.
    const { rows: snaps } = await pool.query<{ price: string; real_price: string | null; at: string }>(
      `select price::text as price, real_price::text as real_price, (extract(epoch from captured_at) * 1000)::bigint::text as at
         from price_snapshots where asset_id = $1 order by captured_at`,
      [ids.a],
    );
    for (const s of snaps) {
      const at = Number(s.at);
      if (at < v.rampStartMs || at >= v.releaseEndMs) expect(s.real_price).toBeNull();
    }
    const atExpiry = snaps.filter((s) => Number(s.at) <= v.candleCloseMs).at(-1);
    expect(inBand(atExpiry?.price, 100.6), `price at expiry ${atExpiry?.price}`).toBe(true);
    expect(atExpiry?.real_price).not.toBeNull();
    expect(atExpiry?.real_price).not.toBe(atExpiry?.price);

    // Entry on a marked OTC price records the override, through the real order service.
    const orders = createOrderService({
      pool,
      prices: redisPriceReader(redis),
      scheduler: redisDueScheduler(redis, QUEUE),
      assets: createAssetRepo(pool, { ttlMs: 0 }),
      limits: createOrderLimitsRepo(pool, { ttlMs: 0 }),
      now: () => clock,
    });
    const user = await newUser('Cliente OTC');
    await pool.query(`insert into accounts (user_id, kind, balance_cents) values ($1, 'real', 100000)`, [user]);
    if (!during) throw new Error('no marked tick in the hold');
    clock = during.rt;
    await redis.set(RedisKeys.price(OTC_A), JSON.stringify(during), 'PX', 600_000);
    const body = { assetId: ids.a, direction: 'call', stakeCents: 1000, durationSec: 60, account: 'real' } as const;
    expect((await orders.create(user, body, randomUUID())).order.overrideId).toBe(v.id);

    // Same expiry, one order opened before the override (natural price), one opened during it.
    const open = async (overrideId: string | null) => {
      const { rows: r } = await pool.query<{ id: string }>(
        `insert into orders (user_id, asset_id, direction, stake_cents, payout_pct, duration_sec, open_price, opens_at, expires_at, idempotency_key, account, override_id)
         values ($1, $2, 'call', 10000, 90, 60, '100.00', $3, $4, $5, 'real', $6) returning id`,
        [user, ids.a, new Date(v.candleCloseMs - MIN), new Date(v.candleCloseMs), randomUUID(), overrideId],
      );
      return r[0]?.id ?? '';
    };
    const closeOf = async (id: string) => {
      await settleOrder(pool, id, v.candleCloseMs + 1500);
      const { rows: r } = await pool.query<{ close_price: string }>('select close_price::text as close_price from orders where id = $1', [
        id,
      ]);
      return r[0]?.close_price;
    };
    // The screen decides for everyone: real_price is diagnostics only.
    expect(await closeOf(await open(null))).toBe(atExpiry?.price);
    expect(await closeOf(await open(v.id))).toBe(atExpiry?.price);
  });
});

describe('HTTP: /api/admin/otc-override', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await testApp({
      redis,
      nameSpace: RL_NS,
      deps: { auth: createAuthService(pool), otcOverride: createOtcOverrideService({ pool, redis, key: KEY }), metrics: new Registry() },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  async function signedIn(role: 'user' | 'admin') {
    const jar = new CookieJar();
    const send = async (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) => {
      const res = await app.inject({
        method,
        url,
        remoteAddress: '10.9.9.9',
        headers: { cookie: jar.header(), 'x-csrf-token': jar.get('__Host-csrf') ?? '' },
        ...(payload ? { payload } : {}),
      });
      jar.store(res.headers['set-cookie']);
      return res;
    };
    const email = `${role}-${randomUUID()}@${DOMAIN}`;
    await send('GET', '/api/auth/csrf');
    expect((await send('POST', '/api/auth/register', { email, password: PASSWORD, name: role })).statusCode).toBe(201);
    if (role === 'admin') await pool.query(`update users set role = 'admin' where email = $1`, [email]);
    expect((await send('POST', '/api/auth/login', { email, password: PASSWORD })).statusCode).toBe(200);
    return send;
  }

  it('admin only; GET, POST and DELETE with no-store', async () => {
    const user = await signedIn('user');
    expect((await user('GET', '/api/admin/otc-override')).statusCode).toBe(403);

    const admin = await signedIn('admin');
    const g = await admin('GET', '/api/admin/otc-override');
    expect(g.statusCode).toBe(200);
    expect(g.headers['cache-control']).toBe('no-store');
    expect(g.json<OtcOverrideState>().override).toBeNull();

    // Real clock here: pick the next candle so the lead check never depends on when the test runs.
    await setPrice(OTC_B, '100.00');
    const p = await admin('POST', '/api/admin/otc-override', { assetId: ids.b, interval: '1m', targetPrice: 100.5, nextCandle: true });
    expect(p.statusCode).toBe(200);
    expect(p.json<{ override: { symbol: string; targetPrice: number } }>().override).toMatchObject({ symbol: OTC_B, targetPrice: 100.5 });
    const ttl = await redis.pttl(KEY);
    expect(ttl).toBeGreaterThan(60_000);
    expect(ttl).toBeLessThanOrEqual(2 * MIN + OTC_OVERRIDE_RELEASE_MS + 10_000);

    const again = await admin('POST', '/api/admin/otc-override', { assetId: ids.b, interval: '1m', targetPrice: 99, nextCandle: true });
    expect(again.statusCode).toBe(409);
    expect((await admin('POST', '/api/admin/otc-override', { assetId: ids.b, interval: '2m', targetPrice: 1 })).statusCode).toBe(400);

    const d = await admin('DELETE', '/api/admin/otc-override');
    expect(d.statusCode).toBe(200);
    expect(d.json()).toEqual({ released: true });
    expect(await redis.get(KEY)).toBeNull();
    expect((await admin('POST', '/api/admin/otc-override', { assetId: ids.market, interval: '1m', targetPrice: 1 })).statusCode).toBe(400);
  });

  it('scheduled: 400 off a minute edge and for ticks under 10 or off the 5 step; TTL counted from closeMs', async () => {
    const admin = await signedIn('admin');
    await redis.set(RedisKeys.price(MKT), JSON.stringify({ p: '50000.00', ts: Date.now(), rt: Date.now(), src: 'binance' }), 'PX', 600_000);
    const atMs = Math.floor(Date.now() / MIN) * MIN + 3 * MIN;
    const post = (schedule: object) => admin('POST', '/api/admin/otc-override', { assetId: ids.mkt, interval: '1m', schedule });

    const edge = await post({ atMs: atMs + 1500, direction: 'up', ticks: 10 });
    expect(edge.statusCode).toBe(400);
    expect(edge.json<{ error: { message: string } }>().error.message).toMatch(/início de um minuto/);
    const few = await post({ atMs, direction: 'up', ticks: 5 });
    expect(few.statusCode).toBe(400);
    expect(few.json<{ error: { message: string } }>().error.message).toMatch(/mínimo é 10 ticks/);
    expect((await post({ atMs, direction: 'up', ticks: 12 })).statusCode).toBe(400);
    expect((await post({ atMs, direction: 'sideways', ticks: 10 })).statusCode).toBe(400);
    expect(await redis.get(KEY)).toBeNull();

    const ok = await post({ atMs, direction: 'down', ticks: 15 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ override: { schedule: unknown; targetPrice: unknown } }>().override).toMatchObject({
      schedule: { direction: 'down', ticks: 15 },
      targetPrice: null,
    });
    const ttl = await redis.pttl(KEY);
    const expected = atMs + MIN + OTC_OVERRIDE_RELEASE_MS + 10_000 - Date.now();
    expect(ttl).toBeGreaterThan(expected - 5000);
    expect(ttl).toBeLessThanOrEqual(expected + 1000);
    expect((await admin('DELETE', '/api/admin/otc-override')).json()).toEqual({ released: true });
  });
});

describe('market assets (1m close only)', () => {
  async function setMarketPrice(p: string, ov?: string): Promise<void> {
    const rec: PriceRecord = { p, ts: clock, rt: clock, src: 'binance', ...(ov ? { ov } : {}) };
    await redis.set(RedisKeys.price(MKT), JSON.stringify(rec), 'PX', 600_000);
  }

  async function client(name: string): Promise<string> {
    const user = await newUser(name);
    await pool.query(`insert into accounts (user_id, kind, balance_cents) values ($1, 'real', 100000)`, [user]);
    return user;
  }

  /** An order expiring at `expiresMs`, opened on a natural price (overrideId null) or on the override's. */
  async function order(user: string, expiresMs: number, overrideId: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `insert into orders (user_id, asset_id, direction, stake_cents, payout_pct, duration_sec, open_price, opens_at, expires_at, idempotency_key, account, override_id)
       values ($1, $2, 'call', 10000, 80, 60, '50000.00', $3, $4, $5, 'real', $6) returning id`,
      [user, ids.mkt, new Date(expiresMs - MIN), new Date(expiresMs), randomUUID(), overrideId],
    );
    return rows[0]?.id ?? '';
  }

  async function snapshot(atMs: number, price: string, realPrice: string | null): Promise<void> {
    await pool.query('insert into price_snapshots (asset_id, price, real_price, captured_at) values ($1, $2, $3, $4)', [
      ids.mkt,
      price,
      realPrice,
      new Date(atMs),
    ]);
  }

  async function settled(orderId: string, nowMs: number) {
    const r = await settleOrder(pool, orderId, nowMs);
    const { rows } = await pool.query<{ status: string; close_price: string }>(
      'select status, close_price::text as close_price from orders where id = $1',
      [orderId],
    );
    return { r, row: rows[0] };
  }

  it('accepted at 1m: ramp over the rest of the candle, wire carries id, kind and jitter', async () => {
    clock = T0 + 20_000;
    await setMarketPrice('50000.00');
    const v = await svc.apply(adminId, input({ assetId: ids.mkt, targetPrice: 50_040.004, rampMs: 500 }));
    expect(v).toMatchObject({ kind: 'market', symbol: MKT, decimals: 2, targetPrice: 50_040, basePrice: 50_000, candleCloseMs: T0 + MIN });
    // The client's rampMs is ignored: 40 s left - hold - landing.
    expect(v.rampStartMs).toBe(T0 + 20_000);
    expect(parseOtcOverride(await redis.get(KEY))).toEqual({
      id: v.id,
      kind: 'market',
      jitter: true,
      symbol: MKT,
      targetPrice: '50040.00',
      basePrice: '50000.00',
      closeMs: T0 + MIN,
      rampStartMs: T0 + 20_000,
      holdMs: OTC_OVERRIDE_HOLD_MS,
      releaseMs: OTC_OVERRIDE_RELEASE_MS,
    });
    const { rows } = await pool.query<{ kind: string; ramp_ms: number }>('select kind, ramp_ms from otc_overrides where id = $1', [v.id]);
    expect(rows[0]).toEqual({ kind: 'market', ramp_ms: 40_000 - OTC_OVERRIDE_HOLD_MS - OTC_OVERRIDE_LANDING_MS });
    const audit = await pool.query<{ payload: Record<string, unknown> }>(
      `select payload from admin_audit where admin_id = $1 and action = 'otc.override' order by id desc limit 1`,
      [adminId],
    );
    expect(audit.rows[0]?.payload).toMatchObject({ kind: 'market', symbol: MKT });

    const state = await svc.get();
    expect(state.assets.find((a) => a.symbol === MKT)).toMatchObject({ kind: 'market', decimals: 2, maxOverridePct: 0.1 });
    expect(state.assets.find((a) => a.symbol === OTC_A)).toMatchObject({ kind: 'otc', maxOverridePct: null });

    expect(await svc.publicState(MKT)).toEqual({ active: true, untilMs: T0 + MIN + OTC_OVERRIDE_RELEASE_MS, scheduledFor: null });
    expect(await svc.publicState(OTC_B)).toEqual({ active: false, untilMs: null, scheduledFor: null });
  });

  it('400 for any interval but 1m', async () => {
    clock = T0 + 20_000;
    await setMarketPrice('50000.00');
    await expectAppError(svc.apply(adminId, input({ assetId: ids.mkt, interval: '5m', targetPrice: 50_010 })), 400, /1m/);
    expect(await redis.get(KEY)).toBeNull();
  });

  it('a market asset created without price_decimals shows in the picker', async () => {
    const state = await svc.get();
    expect(state.assets.find((a) => a.id === ids.mkt)).toMatchObject({ symbol: MKT, kind: 'market', decimals: 2 });
    expect(state.assets.find((a) => a.id === ids.market)).toBeUndefined();
  });

  it('400 above max_override_pct, with the gap and the limit', async () => {
    clock = T0 + 20_000;
    await setMarketPrice('50000.00');
    await expectAppError(
      svc.apply(adminId, input({ assetId: ids.mkt, targetPrice: 50_150 })),
      400,
      new RegExp(`desvio de 0,300% do preço atual \\(50000\\.00\\); o limite de ${MKT} é 0,100%`),
    );
    // Inside the limit is allowed.
    await expect(svc.apply(adminId, input({ assetId: ids.mkt, targetPrice: 49_960 }))).resolves.toMatchObject({ targetPrice: 49_960 });
  });

  it('ignoreBand: the same target past the limit is accepted, and recorded', async () => {
    clock = T0 + 20_000;
    await setMarketPrice('50000.00');
    await expectAppError(
      svc.apply(adminId, input({ assetId: ids.mkt, targetPrice: 50_150, ignoreBand: false })),
      400,
      /Envie ignoreBand para passar/,
    );
    expect(await redis.get(KEY)).toBeNull();
    const v = await svc.apply(adminId, input({ assetId: ids.mkt, targetPrice: 50_150, ignoreBand: true }));
    expect(v.targetPrice).toBe(50_150);
    expect(parseOtcOverride(await redis.get(KEY))?.targetPrice).toBe('50150.00');
    const { rows } = await pool.query<{ ignore_band: boolean }>('select ignore_band from otc_overrides where id = $1', [v.id]);
    expect(rows[0]).toEqual({ ignore_band: true });
    const audit = await pool.query<{ payload: Record<string, unknown> }>(
      `select payload from admin_audit where admin_id = $1 and action = 'otc.override' order by id desc limit 1`,
      [adminId],
    );
    expect(audit.rows[0]?.payload).toMatchObject({ ignoreBand: true });
  });

  it('releaseMs goes to the row, the wire, the TTL and the public state; out of range is a 400', async () => {
    clock = T0 + 20_000;
    await setMarketPrice('50000.00');
    expect(() => input({ assetId: ids.mkt, targetPrice: 50_010, releaseMs: 499 })).toThrow(/mínima/);
    expect(() => input({ assetId: ids.mkt, targetPrice: 50_010, releaseMs: 600_001 })).toThrow(/máxima/);
    const v = await svc.apply(adminId, input({ assetId: ids.mkt, targetPrice: 50_010, releaseMs: 45_000 }));
    expect(v.releaseEndMs).toBe(T0 + MIN + 45_000);
    expect(parseOtcOverride(await redis.get(KEY))?.releaseMs).toBe(45_000);
    const { rows } = await pool.query<{ release_ms: number; ignore_band: boolean }>(
      'select release_ms, ignore_band from otc_overrides where id = $1',
      [v.id],
    );
    expect(rows[0]).toEqual({ release_ms: 45_000, ignore_band: false });
    expect(await svc.publicState(MKT)).toEqual({ active: true, untilMs: T0 + MIN + 45_000, scheduledFor: null });
    // The slot stays taken through the whole return, into the next candle.
    clock = T0 + MIN + 30_000;
    await expectAppError(svc.apply(adminId, input({ assetId: ids.mkt, targetPrice: 50_010 })), 409);
    clock = T0 + MIN + 45_000;
    expect((await svc.get()).override).toBeNull();
  });

  it('an order opened on an overridden price records override_id; one on a natural price does not', async () => {
    clock = T0 + 20_000;
    await setMarketPrice('50000.00');
    const v = await svc.apply(adminId, input({ assetId: ids.mkt, targetPrice: 50_030 }));
    const orders = createOrderService({
      pool,
      prices: redisPriceReader(redis),
      scheduler: redisDueScheduler(redis, QUEUE),
      assets: createAssetRepo(pool, { ttlMs: 0 }),
      limits: createOrderLimitsRepo(pool, { ttlMs: 0 }),
      now: () => clock,
    });
    const user = await client('Cliente entrada');
    const body = { assetId: ids.mkt, direction: 'call', stakeCents: 1000, durationSec: 60, account: 'real' } as const;

    const natural = await orders.create(user, body, randomUUID());
    expect(natural.order.overrideId).toBeNull();

    await setMarketPrice('50021.37', v.id);
    const during = await orders.create(user, body, randomUUID());
    expect(during.order).toMatchObject({ overrideId: v.id, openPrice: '50021.37000000' });
    const { rows } = await pool.query<{ override_id: string | null }>('select override_id::text as override_id from orders where id = $1', [
      during.order.id,
    ]);
    expect(rows[0]?.override_id).toBe(v.id);

    // A malformed or unknown id never breaks the order: it is opened as natural.
    await setMarketPrice('50021.37', '999999999');
    expect((await orders.create(user, body, randomUUID())).order.overrideId).toBeNull();
  });

  it('opened before the override and opened during it: both settle on the shown price', async () => {
    clock = T0 + 20_000;
    await setMarketPrice('50000.00');
    const v = await svc.apply(adminId, input({ assetId: ids.mkt, targetPrice: 50_040 }));
    await pool.query('delete from price_snapshots where asset_id = $1', [ids.mkt]);
    // At expiry the platform shows the target; the market really traded lower.
    await snapshot(v.candleCloseMs - 2000, '50040.00', '49992.10');
    await snapshot(v.candleCloseMs - 400, '50040.00', '49990.55');

    const before = await order(await client('Antes'), v.candleCloseMs, null);
    const during = await order(await client('Durante'), v.candleCloseMs, v.id);

    // The real market would have lost this call; the screen showed 50040 and that is what counts.
    const a = await settled(before, v.candleCloseMs + 1500);
    expect(a.r).toMatchObject({ kind: 'settled', status: 'won' });
    expect(a.row).toEqual({ status: 'won', close_price: '50040.00000000' });

    const b = await settled(during, v.candleCloseMs + 1500);
    expect(b.r).toMatchObject({ kind: 'settled', status: 'won' });
    expect(b.row).toEqual({ status: 'won', close_price: '50040.00000000' });
  });

  it('without an override real_price is null and settlement is unchanged', async () => {
    const close = T0 + 10 * MIN;
    await pool.query('delete from price_snapshots where asset_id = $1', [ids.mkt]);
    await snapshot(close - 700, '50010.00', null);
    const id = await order(await client('Sem override'), close, null);
    const { r, row } = await settled(id, close + 1500);
    expect(r).toMatchObject({ kind: 'settled', status: 'won' });
    expect(row).toEqual({ status: 'won', close_price: '50010.00000000' });
    const { rows } = await pool.query<{ n: string }>(
      'select count(*)::text as n from price_snapshots where asset_id = $1 and real_price is not null',
      [ids.mkt],
    );
    expect(rows[0]?.n).toBe('0');
  });
});

describe('scheduled override (market, 1m)', () => {
  const OPEN = T0 + 10 * MIN;
  const sched = (o: Partial<{ atMs: number; direction: 'up' | 'down'; ticks: number }> = {}) =>
    input({ assetId: ids.mkt, schedule: { atMs: OPEN, direction: 'up', ticks: 20, ...o } });

  beforeEach(async () => {
    clock = T0 + 20_000;
    await redis.set(RedisKeys.price(MKT), JSON.stringify({ p: '50000.00', ts: clock, rt: clock, src: 'binance' }), 'PX', 600_000);
  });

  it('books a future minute: no target yet, the ramp starts at the open, the wire carries the schedule', async () => {
    const v = await svc.apply(adminId, sched());
    expect(v).toMatchObject({
      kind: 'market',
      symbol: MKT,
      targetPrice: null,
      schedule: { direction: 'up', ticks: 20 },
      candleOpenMs: OPEN,
      candleCloseMs: OPEN + MIN,
      rampStartMs: OPEN,
      holdStartMs: OPEN + MIN - OTC_OVERRIDE_HOLD_MS,
    });
    expect(parseOtcOverride(await redis.get(KEY))).toEqual({
      id: v.id,
      kind: 'market',
      jitter: true,
      symbol: MKT,
      basePrice: '50000.00',
      closeMs: OPEN + MIN,
      rampStartMs: OPEN,
      holdMs: OTC_OVERRIDE_HOLD_MS,
      releaseMs: OTC_OVERRIDE_RELEASE_MS,
      schedule: { openMs: OPEN, direction: 'up', ticks: 20, maxOverridePct: 0.1 },
    });
    const { rows } = await pool.query<{ target_price: string | null; direction: string; body_ticks: number; ramp_ms: number }>(
      'select target_price::text as target_price, direction, body_ticks, ramp_ms from otc_overrides where id = $1',
      [v.id],
    );
    expect(rows[0]).toEqual({
      target_price: null,
      direction: 'up',
      body_ticks: 20,
      ramp_ms: MIN - OTC_OVERRIDE_HOLD_MS - OTC_OVERRIDE_LANDING_MS,
    });
    expect(await svc.publicState(MKT)).toEqual({ active: true, untilMs: OPEN + MIN + OTC_OVERRIDE_RELEASE_MS, scheduledFor: OPEN });
  });

  it('400 in the past, inside the minimum lead, past the horizon, on an OTC asset, and with the slot taken', async () => {
    await expectAppError(svc.apply(adminId, sched({ atMs: T0 })), 400, /mais de 6 s/);
    // The next minute opens in 40 s: fine. At 55 s into the minute it is inside the lead.
    clock = T0 + MIN - OTC_OVERRIDE_MIN_LEAD_MS + 1;
    await expectAppError(svc.apply(adminId, sched({ atMs: T0 + MIN })), 400, /mais de 6 s/);
    clock = T0 + 20_000;
    await expectAppError(svc.apply(adminId, sched({ atMs: T0 + OTC_OVERRIDE_SCHEDULE_HORIZON_MS + MIN })), 400, /60 min/);
    await expectAppError(
      svc.apply(adminId, input({ assetId: ids.a, schedule: { atMs: OPEN, direction: 'up', ticks: 10 } })),
      400,
      /mercado/,
    );
    await expectAppError(
      svc.apply(adminId, input({ assetId: ids.mkt, interval: '5m', schedule: { atMs: OPEN, direction: 'up', ticks: 10 } })),
      400,
      /1m/,
    );
    expect(await redis.get(KEY)).toBeNull();

    // Exactly at the horizon is still allowed; then the slot is taken.
    const first = await svc.apply(adminId, sched({ atMs: T0 + OTC_OVERRIDE_SCHEDULE_HORIZON_MS }));
    expect(first.candleOpenMs).toBe(T0 + OTC_OVERRIDE_SCHEDULE_HORIZON_MS);
    await expectAppError(svc.apply(adminId, sched()), 400, /Já existe um override ativo/);
    // An immediate one is still a 409, as before.
    await expectAppError(svc.apply(adminId, input({ assetId: ids.mkt, targetPrice: 50_010 })), 409);
  });

  it('ignoreBand and releaseMs reach the scheduled wire and row; without ignoreBand the wire has none', async () => {
    const v = await svc.apply(adminId, input({ ...sched(), releaseMs: 45_000, ignoreBand: true }));
    const wire = parseOtcOverride(await redis.get(KEY));
    expect(wire?.releaseMs).toBe(45_000);
    expect(wire?.schedule).toEqual({ openMs: OPEN, direction: 'up', ticks: 20, maxOverridePct: 0.1, ignoreBand: true });
    const { rows } = await pool.query<{ release_ms: number; ignore_band: boolean }>(
      'select release_ms, ignore_band from otc_overrides where id = $1',
      [v.id],
    );
    expect(rows[0]).toEqual({ release_ms: 45_000, ignore_band: true });
    expect(v.releaseEndMs).toBe(OPEN + MIN + 45_000);

    // The ws keeps the whole body: 10 000 ticks of 0.01 is 0.2% of 50 000, twice the 0.1% limit.
    await svc.release(adminId);
    await svc.apply(adminId, input({ ...sched({ ticks: 10_000 }), ignoreBand: true }));
    const big = parseOtcOverride(await redis.get(KEY));
    if (!big) throw new Error('no wire');
    const ov = new PriceOverride(big, clock, { decimals: 2, volPerSqrtS: null });
    const t = { symbol: MKT, price: '50000.00', value: 50_000, ts: OPEN, recvMs: OPEN, provider: 'binance' as const };
    ov.apply(t, OPEN, 50_000);
    expect(ov.bodyTicks).toBe(10_000);
    expect(ov.targetPrice).toBe(50_100);

    await svc.release(adminId);
    await svc.apply(adminId, sched());
    expect(parseOtcOverride(await redis.get(KEY))?.schedule).not.toHaveProperty('ignoreBand');
  });

  it('cancelled before the open with the usual release: row ended, key gone, slot free', async () => {
    const v = await svc.apply(adminId, sched());
    clock = OPEN - 5000;
    expect(await svc.release(adminId)).toBe(true);
    expect(await redis.get(KEY)).toBeNull();
    const { rows } = await pool.query<{ active: boolean }>('select active from otc_overrides where id = $1', [v.id]);
    expect(rows[0]).toEqual({ active: false });
    expect((await svc.apply(adminId, sched({ atMs: OPEN + MIN }))).candleOpenMs).toBe(OPEN + MIN);
  });

  it('the ws resolves the target from the open: the previous candle is raw, the close is open + ticks, saved once', async () => {
    const v = await svc.apply(adminId, sched({ ticks: 25 }));
    const wire = parseOtcOverride(await redis.get(KEY));
    if (!wire) throw new Error('no wire');
    const saved: string[] = [];
    const ov = new PriceOverride(wire, clock, { decimals: 2, volPerSqrtS: null, onTarget: (p) => saved.push(p) });
    const tick = (at: number, p: number) => ({
      symbol: MKT,
      price: p.toFixed(2),
      value: p,
      ts: at,
      recvMs: at,
      provider: 'binance' as const,
    });
    // Previous minute: untouched.
    for (let at = OPEN - 10_000; at < OPEN; at += 500) {
      const t = tick(at, 50_001);
      expect(ov.apply(t, at)).toEqual(t);
    }
    let close = 0;
    for (let at = OPEN; at <= OPEN + MIN; at += 250) {
      const out = ov.apply(tick(at, 50_002), at, ov.needsOpen(at) ? 50_001 : undefined);
      expect(out.ov).toBe(v.id);
      if (at === OPEN + MIN) close = out.value;
    }
    expect(saved).toEqual(['50001.25']);
    expect(close).toBeGreaterThan(50_001);
    await saveOverrideTarget(pool, v.id, saved[0]!);
    // First write wins: a restarted ws cannot move it.
    await saveOverrideTarget(pool, v.id, '50009.99');
    const state = await svc.get();
    expect(state.override).toMatchObject({ id: v.id, targetPrice: 50_001.25 });
  });

  // Its own minute: earlier tests leave override rows on OPEN.
  const BOOKED = OPEN + 5 * MIN;

  it('ws restarted inside the candle: the second run reads target_price and closes on the saved target', async () => {
    const v = await svc.apply(adminId, sched({ atMs: BOOKED, ticks: 20 }));
    const wire = parseOtcOverride(await redis.get(KEY));
    if (!wire) throw new Error('no wire');
    const tick = (at: number, p: number) => ({
      symbol: MKT,
      price: p.toFixed(2),
      value: p,
      ts: at,
      recvMs: at,
      provider: 'binance' as const,
    });
    expect(await loadOverrideTarget(pool, v.id)).toBeNull();

    // First run: open 50 001, freezes 50 001.20 and saves it, then dies at +40 s.
    const first = new PriceOverride(wire, BOOKED - 1000, {
      decimals: 2,
      volPerSqrtS: null,
      onTarget: (p) => void saveOverrideTarget(pool, v.id, p),
    });
    for (let at = BOOKED; at <= BOOKED + 40_000; at += 250) first.apply(tick(at, 50_002), at, first.needsOpen(at) ? 50_001 : undefined);
    await vi.waitFor(async () => expect(await loadOverrideTarget(pool, v.id)).toBe('50001.20000000'));

    // Second run: no bucketOpen, first tick 50 030 (it alone would give 50 030.20).
    const persisted = Number(await loadOverrideTarget(pool, v.id));
    const saved: string[] = [];
    const second = new PriceOverride(wire, BOOKED + 41_000, {
      decimals: 2,
      volPerSqrtS: null,
      persistedTarget: persisted,
      onTarget: (p) => saved.push(p),
    });
    let close = 0;
    for (let at = BOOKED + 41_000; at <= BOOKED + MIN; at += 250) {
      const out = second.apply(tick(at, 50_030), at, undefined);
      if (at === BOOKED + MIN) close = out.value;
    }
    expect(close).toBe(50_001.2);
    expect(saved).toEqual([]);
  });
});
