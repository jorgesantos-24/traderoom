// Requires `npm run dev:deps` and `npm run db:migrate` first.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import {
  OTC_OVERRIDE_HOLD_MS,
  OTC_OVERRIDE_LANDING_MS,
  OTC_OVERRIDE_RAMP_DEFAULT_MS,
  OTC_OVERRIDE_RELEASE_MS,
  OtcOverrideInput,
  parseOtcOverride,
  RedisKeys,
  Registry,
  type OtcOverrideState,
} from '@traderoom/shared';
// The real generator, driven by the wire this API writes: the same code the ws runs.
import { OtcWalk } from '../../ws/src/feed/otc.js';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/lib/errors.js';
import { createPool } from '../src/lib/db.js';
import { createRedis } from '../src/lib/redis.js';
import { createAuthService } from '../src/services/auth.js';
import { createOtcOverrideService, type OtcOverrideService } from '../src/services/otc-override.js';
import { settleOrder } from '../src/services/settlement.js';
import { CookieJar, testApp } from './helpers.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const DOMAIN = 'otc-override-int.traderoom.test';
const RUN = randomUUID().slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X');
const OTC_A = `ZZOVA${RUN}`;
const OTC_B = `ZZOVB${RUN}`;
const MARKET = `ZZOVM${RUN}USDT`;
/** Own key: a ws running on this machine keeps reading the real one. */
const KEY = `otc:override:test:${RUN}`;
const RL_NS = `rl-otc-override-int-${RUN}:`;
const PASSWORD = 'senha-forte-123';
const MIN = 60_000;

let pool: pg.Pool;
let redis: Redis;
let adminId: string;
const ids: Record<'a' | 'b' | 'market', number> = { a: 0, b: 0, market: 0 };
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
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (email, password_hash, name) values ($1, '!', $2) returning id`,
    [`u-${randomUUID()}@${DOMAIN}`, name],
  );
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
  ids.market = (
    await pool.query<{ id: number }>(
      `insert into assets (symbol, display, binance_stream, payout_pct, enabled, sort) values ($1, 'Teste M', $2, 80, true, 9991) returning id`,
      [MARKET, `${MARKET.toLowerCase()}@trade`],
    )
  ).rows[0]?.id ?? 0;
  adminId = await newUser('Admin OTC');
  // A leftover active override (from a crashed run or the dev UI) would make every test 409.
  const active = await pool.query<{ symbol: string }>(`select a.symbol from otc_overrides o join assets a on a.id = o.asset_id where o.active`);
  if (active.rows[0]) throw new Error(`an OTC override is active (${active.rows[0].symbol}); release it before running this suite`);
});

afterEach(async () => {
  await svc.release(adminId);
  clock = T0;
});

afterAll(async () => {
  const assetIds = [ids.a, ids.b, ids.market];
  const users = `select id from users where email like '%@${DOMAIN}'`;
  await pool.query('delete from otc_overrides where asset_id = any($1)', [assetIds]);
  await pool.query(`delete from admin_audit where admin_id in (${users})`);
  await pool.query(`delete from ledger where user_id in (${users})`);
  await pool.query(`delete from orders where user_id in (${users})`);
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`]);
  await pool.query('delete from price_snapshots where asset_id = any($1)', [assetIds]);
  await pool.query('delete from assets where id = any($1)', [assetIds]);
  await redis.del(KEY, RedisKeys.price(OTC_A), RedisKeys.price(OTC_B));
  await pool.end();
  redis.disconnect();
});

describe('apply', () => {
  it('writes the row, the audit and the Redis wire for the current candle', async () => {
    clock = T0 + 20_000;
    await setPrice(OTC_A, '100.00');
    const v = await svc.apply(adminId, input({ assetId: ids.a, targetPrice: 101.234 }));
    expect(v).toMatchObject({ symbol: OTC_A, targetPrice: 101.23, basePrice: 100, candleOpenMs: T0, candleCloseMs: T0 + MIN, phase: 'ramp' });
    expect(v.rampStartMs).toBe(T0 + MIN - OTC_OVERRIDE_HOLD_MS - OTC_OVERRIDE_LANDING_MS - OTC_OVERRIDE_RAMP_DEFAULT_MS);

    const wire = parseOtcOverride(await redis.get(KEY));
    expect(wire).toEqual({
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
    await expectAppError(svc.apply(adminId, input({ assetId: ids.b, targetPrice: 99 })), 409, new RegExp(`Já existe um override ativo \\(ativo ${OTC_A}, faltam 50s\\)`));
    // The rejected attempt left nothing behind.
    expect(parseOtcOverride(await redis.get(KEY))?.symbol).toBe(OTC_A);
  });

  it('400 for a market (non-OTC) asset, 404 for an unknown one', async () => {
    await expectAppError(svc.apply(adminId, input({ assetId: ids.market, targetPrice: 50 })), 400, /OTC/);
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
    const { rows } = await pool.query<{ active: boolean; ended_at: Date | null }>('select active, ended_at from otc_overrides where id = $1', [second.id]);
    expect(rows[0]).toMatchObject({ active: false });
    expect(rows[0]?.ended_at).not.toBeNull();
  });
});

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

  it('an order expiring at the close settles at the target and wins', async () => {
    for (const [dir, target] of [
      ['call', 100.6],
      ['put', 99.4],
    ] as const) {
      clock = T0 + 15_000;
      await setPrice(OTC_A, '100.00');
      const v = await svc.apply(adminId, input({ assetId: ids.a, targetPrice: target }));
      const wire = parseOtcOverride(await redis.get(KEY));
      expect(wire).not.toBeNull();

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
      const walk = new OtcWalk({ startPrice: 100, volPctHour: 0.8, decimals: 2 }, 100, seeded(dir === 'call' ? 7 : 8));
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
      for (const s of inHold) expect(s.price).toBe(target.toFixed(2));

      const r = await settleOrder(pool, orderId, v.candleCloseMs + 1500);
      expect(r).toMatchObject({ kind: 'settled', status: 'won' });
      const { rows: o } = await pool.query<{ status: string; close_price: string }>(
        'select status, close_price::text as close_price from orders where id = $1',
        [orderId],
      );
      expect(o[0]).toEqual({ status: 'won', close_price: target.toFixed(8) });
      const { rows: l } = await pool.query<{ kind: string; delta_cents: string }>('select kind, delta_cents from ledger where order_id = $1', [orderId]);
      expect(l).toEqual([{ kind: 'payout', delta_cents: '19000' }]);

      await svc.release(adminId);
    }
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
});
