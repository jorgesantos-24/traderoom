// Requires `npm run dev:deps` and `npm run db:migrate` first.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { candleExpiry, RedisKeys, Registry, type CreateOrderInput, type OrderView, type PriceRecord } from '@traderoom/shared';
import { loadConfig } from '../src/config.js';
import { inTransaction, createPool } from '../src/lib/db.js';
import { createRedis } from '../src/lib/redis.js';
import { createAssetRepo } from '../src/services/assets.js';
import { createAuthService } from '../src/services/auth.js';
import { createOrderLimitsRepo } from '../src/services/order-limits.js';
import { createOrderService, redisDueScheduler, redisPriceReader, type OrderService } from '../src/services/orders.js';
import { settleOrder, VOID_NOTES } from '../src/services/settlement.js';
import { createWalletService } from '../src/services/wallet.js';
import { redisDueQueue, SettlementWorker, WORKER_DEFAULTS } from '../src/worker/settlement-worker.js';
import { CookieJar, testApp } from './helpers.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const DOMAIN = 'orders-int.traderoom.test';
const SYMBOL = 'ZZORDUSDT';
const QUEUE = `orders:due:test-${randomUUID()}`;
const RL_NS = `rl-orders-int-${randomUUID()}:`;
const log = Fastify({ logger: false }).log;

let pool: pg.Pool;
let redis: Redis;
let assetId: number;
let clock = Date.now();
let svc: OrderService;
/** otc_overrides.created_by */
let creator: string;

function service(): OrderService {
  return createOrderService({
    pool,
    prices: redisPriceReader(redis),
    scheduler: redisDueScheduler(redis, QUEUE),
    assets: createAssetRepo(pool, { ttlMs: 0 }),
    limits: createOrderLimitsRepo(pool, { ttlMs: 0 }),
    now: () => clock,
  });
}

async function setPrice(p: string, rt = clock, extra: { ov?: string; realPrice?: string } = {}): Promise<void> {
  const rec: PriceRecord = { p, ts: rt, rt, src: 'binance', ...extra };
  await redis.set(RedisKeys.price(SYMBOL), JSON.stringify(rec), 'PX', 60_000);
}

async function newUser(balanceCents = 0): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (email, password_hash, name) values ($1, '!', 'Ordens') returning id`,
    [`u-${randomUUID()}@${DOMAIN}`],
  );
  const id = rows[0]?.id ?? '';
  await pool.query('insert into accounts (user_id) values ($1)', [id]);
  if (balanceCents > 0) await credit(id, balanceCents);
  return id;
}

/** Stand-in for the admin credit of milestone 7: same ledger rules. */
async function credit(userId: string, cents: number): Promise<void> {
  await inTransaction(pool, async (c) => {
    const { rows } = await c.query<{ balance_cents: string }>(`select balance_cents from accounts where user_id = $1 and kind = 'real' for update`, [userId]);
    const after = Number(rows[0]?.balance_cents) + cents;
    await c.query(`update accounts set balance_cents = $2 where user_id = $1 and kind = 'real'`, [userId, after]);
    await c.query(`insert into ledger (user_id, delta_cents, balance_after, kind, note) values ($1, $2, $3, 'credit', 'teste')`, [
      userId,
      cents,
      after,
    ]);
  });
}

async function balance(userId: string): Promise<number> {
  const { rows } = await pool.query<{ b: string }>('select balance_cents as b from accounts where user_id = $1', [userId]);
  return Number(rows[0]?.b);
}

async function ledgerOf(userId: string): Promise<Array<{ kind: string; delta: number; after: number; note: string | null }>> {
  const { rows } = await pool.query<{ kind: string; delta_cents: string; balance_after: string; note: string | null }>(
    'select kind, delta_cents, balance_after, note from ledger where user_id = $1 order by id',
    [userId],
  );
  return rows.map((r) => ({ kind: r.kind, delta: Number(r.delta_cents), after: Number(r.balance_after), note: r.note }));
}

async function snapshot(price: string, at: number, realPrice: string | null = null): Promise<void> {
  await pool.query('insert into price_snapshots (asset_id, price, real_price, captured_at) values ($1, $2, $3, $4)', [
    assetId,
    price,
    realPrice,
    new Date(at),
  ]);
}

/**
 * An otc_overrides row only so orders.override_id has a target. Inactive: the unique index allows one
 * active override in the whole table, and settlement never looks at it anyway.
 */
async function overrideRow(target: string, closeMs: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into otc_overrides (asset_id, kind, interval_sec, target_price, base_price, candle_open_ms, candle_close_ms, ramp_ms, created_by, active)
     values ($1, 'market', 60, $2, '100.00000000', $3, $4, 25000, $5, false) returning id::text as id`,
    [assetId, target, closeMs - 60_000, closeMs, creator],
  );
  return rows[0]?.id ?? '';
}

const input = (o: Partial<CreateOrderInput> = {}): CreateOrderInput => ({
  account: 'real',
  assetId,
  direction: 'call',
  stakeCents: 1000,
  durationSec: 60,
  ...o,
});
const key = () => `k-${randomUUID()}`;
/** 1 s into a minute candle that started 2+ min before `now`: an order sent then expired 60+ s ago. */
const longAgo = (now: number) => Math.floor((now - 130_000) / 60_000) * 60_000 + 1_000;

beforeAll(async () => {
  pool = createPool(config);
  redis = createRedis(config);
  const { rows } = await pool.query<{ id: number }>(
    `insert into assets (symbol, display, binance_stream, payout_pct, enabled, sort)
     values ($1, 'ZZORD/USD', $2, 87, true, 9998)
     on conflict (symbol) do update set enabled = true, payout_pct = 87 returning id`,
    [SYMBOL, `${SYMBOL.toLowerCase()}@bookTicker`],
  );
  assetId = rows[0]?.id ?? 0;
  creator = await newUser();
  svc = service();
});

afterAll(async () => {
  const users = `select id from users where email like '%@${DOMAIN}'`;
  await pool.query(`delete from ledger where user_id in (${users})`);
  await pool.query(`delete from orders where user_id in (${users})`);
  // Before the users: otc_overrides.created_by points at one of them.
  await pool.query('delete from otc_overrides where asset_id = $1', [assetId]);
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`]);
  await pool.query('delete from price_snapshots where asset_id = $1', [assetId]);
  await pool.query('delete from assets where id = $1', [assetId]);
  const rl = await redis.keys(`${RL_NS}*`);
  await redis.del(RedisKeys.price(SYMBOL), QUEUE, ...rl);
  await Promise.all([pool.end(), redis.quit()]);
});

describe('creating orders', () => {
  it('debits the stake, writes a stake ledger row and schedules settlement', async () => {
    clock = Date.now();
    await setPrice('75552.63000000');
    const user = await newUser(10_000);
    const { order, replayed } = await svc.create(user, input(), key());
    expect(replayed).toBe(false);
    expect(order).toMatchObject({
      assetId,
      symbol: SYMBOL,
      status: 'open',
      openPrice: '75552.63000000',
      payoutPct: 87,
      stakeCents: 1000,
      potentialPayoutCents: 1870,
    });
    expect(Date.parse(order.expiresAt)).toBe(candleExpiry(clock, 60).closesAt);
    expect(await balance(user)).toBe(9000);
    expect((await ledgerOf(user)).at(-1)).toEqual({ kind: 'stake', delta: -1000, after: 9000, note: null });
    expect(Number(await redis.zscore(QUEUE, order.id))).toBe(Date.parse(order.expiresAt));
    expect(await createWalletService(pool).get(user, 'real')).toEqual({
      account: 'real',
      balanceCents: 9000,
      currency: 'USD',
      openStakeCents: 1000,
      openOrders: 1,
    });
  });

  it('replays the same Idempotency-Key without a second debit, even after the price goes stale', async () => {
    clock = Date.now();
    await setPrice('100.00000000');
    const user = await newUser(5000);
    const k = key();
    const first = await svc.create(user, input(), k);
    await setPrice('100.00000000', clock - 10_000);
    const again = await svc.create(user, input(), k);
    expect(again).toEqual({ order: first.order, replayed: true });
    expect(await balance(user)).toBe(4000);
    expect((await ledgerOf(user)).filter((l) => l.kind === 'stake')).toHaveLength(1);
  });

  it('refuses the same key with a different body (409)', async () => {
    clock = Date.now();
    await setPrice('100.00000000');
    const user = await newUser(5000);
    const k = key();
    await svc.create(user, input(), k);
    await expect(svc.create(user, input({ stakeCents: 2000 }), k)).rejects.toMatchObject({ statusCode: 409, code: 'idempotency_conflict' });
  });

  it('lets two users use the same key value independently', async () => {
    clock = Date.now();
    await setPrice('100.00000000');
    const [a, b] = [await newUser(5000), await newUser(5000)];
    const k = key();
    const ra = await svc.create(a, input(), k);
    const rb = await svc.create(b, input(), k);
    expect(ra.order.id).not.toBe(rb.order.id);
  });

  it('creates exactly one order when the same key arrives 10 times in parallel', async () => {
    clock = Date.now();
    await setPrice('100.00000000');
    const user = await newUser(5000);
    const k = key();
    const results = await Promise.all(Array.from({ length: 10 }, () => svc.create(user, input(), k)));
    expect(new Set(results.map((r) => r.order.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await balance(user)).toBe(4000);
  });

  it('never overdraws: 15 parallel orders on a balance for 10', async () => {
    clock = Date.now();
    await setPrice('100.00000000');
    const user = await newUser(10_000);
    const results = await Promise.allSettled(Array.from({ length: 15 }, () => svc.create(user, input(), key())));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(10);
    expect(failed.every((f) => (f.reason as { code?: string }).code === 'insufficient_balance')).toBe(true);
    expect(await balance(user)).toBe(0);
    const l = await ledgerOf(user);
    expect(l.filter((x) => x.kind === 'stake')).toHaveLength(10);
    // balance_after is a consistent running total.
    let running = 0;
    for (const row of l) {
      running += row.delta;
      expect(row.after).toBe(running);
    }
  });

  it('refuses insufficient balance with 400 before touching anything', async () => {
    clock = Date.now();
    await setPrice('100.00000000');
    const user = await newUser(500);
    await expect(svc.create(user, input({ stakeCents: 1000 }), key())).rejects.toMatchObject({
      statusCode: 400,
      code: 'insufficient_balance',
    });
    expect(await balance(user)).toBe(500);
    expect((await ledgerOf(user)).map((l) => l.kind)).toEqual(['credit']);
  });

  it('refuses orders while the price is stale or missing', async () => {
    clock = Date.now();
    const user = await newUser(5000);
    await setPrice('100.00000000', clock - 2001);
    await expect(svc.create(user, input(), key())).rejects.toMatchObject({ statusCode: 409, code: 'asset_stale' });
    await redis.del(RedisKeys.price(SYMBOL));
    await expect(svc.create(user, input(), key())).rejects.toMatchObject({ statusCode: 409, code: 'asset_stale' });
    await setPrice('100.00000000', clock - 2000);
    await expect(svc.create(user, input(), key())).resolves.toMatchObject({ replayed: false });
  });

  describe('entry delay (anti latency-arbitrage)', () => {
    const DELAY = 500;
    /** Fake time: each sleep advances the clock, and `feed` says which price the relay has written by then. */
    function delayed(feed: (t: number) => { p: string; rt: number } | null) {
      return createOrderService({
        pool,
        prices: redisPriceReader(redis),
        scheduler: redisDueScheduler(redis, QUEUE),
        assets: createAssetRepo(pool, { ttlMs: 0 }),
        limits: createOrderLimitsRepo(pool, { ttlMs: 0 }),
        entryDelayMs: DELAY,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          const px = feed(clock);
          if (px) await setPrice(px.p, px.rt);
        },
      });
    }

    it('opens at the first price received after the delay, not the price on screen', async () => {
      clock = Date.now();
      const arrived = clock;
      await setPrice('100.00000000'); // what the bot (and the screen) saw
      // Our feed catches up with the move 300 ms later, then ticks every 200 ms.
      const s = delayed((t) =>
        t - arrived >= 300 ? { p: '101.00000000', rt: arrived + 300 + Math.floor((t - arrived - 300) / 200) * 200 } : null,
      );
      const user = await newUser(5000);
      const { order } = await s.create(user, input(), key());
      expect(order.openPrice).toBe('101.00000000');
      const opened = Date.parse(order.opensAt);
      expect(opened).toBeGreaterThanOrEqual(arrived + DELAY);
      expect(Date.parse(order.expiresAt)).toBe(candleExpiry(arrived, 60).closesAt);
    });

    it('waits for a quiet asset to refresh, then opens', async () => {
      clock = Date.now();
      const arrived = clock;
      await setPrice('2.00000000');
      // No ticks until the 1 s heartbeat.
      const s = delayed((t) => (t - arrived >= 1000 ? { p: '2.00010000', rt: arrived + 1000 } : null));
      const { order } = await s.create(await newUser(5000), input(), key());
      expect(order.openPrice).toBe('2.00010000');
      expect(Date.parse(order.opensAt)).toBeGreaterThanOrEqual(arrived + 1000);
    });

    it('refuses as stale when no fresh price arrives in time, without debiting', async () => {
      clock = Date.now();
      await setPrice('100.00000000');
      const s = delayed(() => null);
      const user = await newUser(5000);
      await expect(s.create(user, input(), key())).rejects.toMatchObject({ statusCode: 409, code: 'asset_stale' });
      expect(await balance(user)).toBe(5000);
    });
  });

  it('validates asset, duration and stake limits from the config table', async () => {
    clock = Date.now();
    await setPrice('100.00000000');
    const user = await newUser(5_000_000);
    await expect(svc.create(user, input({ assetId: 999_999 }), key())).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.create(user, input({ durationSec: 120 }), key())).rejects.toMatchObject({
      statusCode: 400,
      message: `durationSec: duração não permitida. Use: ${(await createOrderLimitsRepo(pool, { ttlMs: 0 }).get()).durationsSec.join(', ')} s.`,
    });
    await expect(svc.create(user, input({ stakeCents: 99 }), key())).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.create(user, input({ stakeCents: 1_000_001 }), key())).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.create(user, input({ durationSec: 300, stakeCents: 100 }), key())).resolves.toBeDefined();
  });
});

describe('demo account', () => {
  async function demoUser(demoCents = 1_000_000): Promise<string> {
    const id = await newUser(5000);
    await pool.query(`insert into accounts (user_id, kind, balance_cents) values ($1, 'demo', $2)`, [id, demoCents]);
    return id;
  }
  const balances = async (userId: string) => {
    const { rows } = await pool.query<{ kind: string; b: string }>('select kind, balance_cents as b from accounts where user_id = $1', [
      userId,
    ]);
    return Object.fromEntries(rows.map((r) => [r.kind, Number(r.b)]));
  };

  it('stakes, settles and lists on the demo balance only', async () => {
    await pool.query('delete from price_snapshots where asset_id = $1', [assetId]);
    const realNow = Date.now();
    clock = longAgo(realNow);
    await setPrice('100.00000000');
    const user = await demoUser();
    const { order } = await svc.create(user, input({ account: 'demo', stakeCents: 2000 }), key());
    expect(order.account).toBe('demo');
    expect(await balances(user)).toEqual({ real: 5000, demo: 998_000 });

    clock = realNow;
    await snapshot('100.00000001', Date.parse(order.expiresAt) - 500);
    expect(await settleOrder(pool, order.id, realNow)).toMatchObject({ kind: 'settled', status: 'won', creditCents: 3740 });
    expect(await balances(user)).toEqual({ real: 5000, demo: 1_001_740 });

    expect((await svc.list(user, { account: 'demo', limit: 10 })).items.map((o) => o.id)).toEqual([order.id]);
    expect((await svc.list(user, { account: 'real', limit: 10 })).items).toEqual([]);
    const wallet = createWalletService(pool);
    expect((await wallet.ledger(user, { account: 'demo', limit: 10 })).items.map((e) => e.kind)).toEqual(['payout', 'stake']);
    expect((await wallet.ledger(user, { account: 'real', limit: 10 })).items.map((e) => e.kind)).toEqual(['credit']);
    expect((await wallet.all(user)).map((w) => [w.account, w.balanceCents])).toEqual([
      ['real', 5000],
      ['demo', 1_001_740],
    ]);
  });

  it('a demo stake larger than the demo balance is refused even when real could pay it', async () => {
    clock = Date.now();
    await setPrice('100.00000000');
    const user = await demoUser(500);
    await expect(svc.create(user, input({ account: 'demo', stakeCents: 1000 }), key())).rejects.toMatchObject({ statusCode: 400 });
    expect(await balances(user)).toEqual({ real: 5000, demo: 500 });
  });

  it('refills the demo balance up to US$ 10.000, never above', async () => {
    const wallet = createWalletService(pool);
    const user = await demoUser(1234);
    expect(await wallet.refillDemo(user)).toMatchObject({ account: 'demo', balanceCents: 1_000_000 });
    const rows = (await wallet.ledger(user, { account: 'demo', limit: 10 })).items;
    expect(rows).toMatchObject([{ kind: 'adjust', deltaCents: 998_766, balanceAfterCents: 1_000_000 }]);
    await wallet.refillDemo(user);
    expect((await wallet.ledger(user, { account: 'demo', limit: 10 })).items).toHaveLength(1);
    expect(await balances(user)).toEqual({ real: 5000, demo: 1_000_000 });
  });
});

describe('settlement', () => {
  /** Opens an order early in a 1 min candle more than 2 min ago, so it has already expired. */
  async function expiredOrder(o: Partial<CreateOrderInput> = {}, open = '100.00000000') {
    // Each case controls its own close price: earlier cases' snapshots would fall in the same window.
    await pool.query('delete from price_snapshots where asset_id = $1', [assetId]);
    const realNow = Date.now();
    clock = longAgo(realNow);
    await setPrice(open);
    const user = await newUser(10_000);
    const { order } = await svc.create(user, input(o), key());
    clock = realNow;
    return { user, order, expires: Date.parse(order.expiresAt), now: realNow };
  }

  async function orderRow(id: string): Promise<OrderView['status'] & string> {
    const { rows } = await pool.query<{ status: OrderView['status'] }>('select status from orders where id = $1', [id]);
    return rows[0]?.status ?? 'open';
  }

  it('call wins when close > open: credits stake + profit as payout', async () => {
    const { user, order, expires, now } = await expiredOrder({ direction: 'call', stakeCents: 1001 });
    await snapshot('100.00000001', expires - 500);
    expect(await settleOrder(pool, order.id, now)).toMatchObject({ kind: 'settled', status: 'won', creditCents: 1871 });
    expect(await balance(user)).toBe(10_000 - 1001 + 1871);
    expect((await ledgerOf(user)).at(-1)).toEqual({ kind: 'payout', delta: 1871, after: 10_870, note: null });
    const { rows } = await pool.query<{ close_price: string; settled_at: Date | null }>(
      'select close_price::text, settled_at from orders where id = $1',
      [order.id],
    );
    expect(rows[0]?.close_price).toBe('100.00000001');
    expect(rows[0]?.settled_at).toBeInstanceOf(Date);
  });

  it('put loses when close > open: nothing is credited', async () => {
    const { user, order, expires, now } = await expiredOrder({ direction: 'put' });
    await snapshot('100.50000000', expires - 500);
    expect(await settleOrder(pool, order.id, now)).toMatchObject({ status: 'lost', creditCents: 0 });
    expect(await balance(user)).toBe(9000);
    expect((await ledgerOf(user)).map((l) => l.kind)).toEqual(['credit', 'stake']);
  });

  it('put wins when close < open', async () => {
    const { order, expires, now } = await expiredOrder({ direction: 'put' });
    await snapshot('99.99999999', expires - 500);
    expect(await settleOrder(pool, order.id, now)).toMatchObject({ status: 'won', creditCents: 1870 });
  });

  it('a tie is void and refunds the stake', async () => {
    const { user, order, expires, now } = await expiredOrder();
    await snapshot('100.00000000', expires - 500);
    expect(await settleOrder(pool, order.id, now)).toMatchObject({ status: 'void', creditCents: 1000 });
    expect(await balance(user)).toBe(10_000);
    expect((await ledgerOf(user)).at(-1)).toEqual({ kind: 'refund', delta: 1000, after: 10_000, note: VOID_NOTES.tie });
  });

  it('no snapshot within 3 s before expiry is void with a refund', async () => {
    const { user, order, expires, now } = await expiredOrder();
    await snapshot('150.00000000', expires - 3500); // too old
    await snapshot('150.00000000', expires + 200); // after expiry: never used
    expect(await settleOrder(pool, order.id, now)).toMatchObject({ status: 'void', creditCents: 1000 });
    expect((await ledgerOf(user)).at(-1)?.note).toBe(VOID_NOTES.noPrice);
    const { rows } = await pool.query<{ close_price: string | null }>('select close_price from orders where id = $1', [order.id]);
    expect(rows[0]?.close_price).toBeNull();
  });

  it('uses the latest snapshot at or before expiry', async () => {
    const { order, expires, now } = await expiredOrder({ direction: 'put' });
    await snapshot('101.00000000', expires - 2500);
    await snapshot('99.00000000', expires); // exactly at expiry counts
    expect(await settleOrder(pool, order.id, now)).toMatchObject({ status: 'won' });
  });

  it('never settles twice, sequentially or in parallel', async () => {
    const { user, order, expires, now } = await expiredOrder();
    await snapshot('120.00000000', expires - 500);
    const results = await Promise.all(Array.from({ length: 6 }, () => settleOrder(pool, order.id, now)));
    if (results.filter((r) => r.kind === 'settled').length !== 1) throw new Error(JSON.stringify(results));
    expect(results.filter((r) => r.kind === 'settled')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'already_settled')).toHaveLength(5);
    expect(await settleOrder(pool, order.id, now)).toEqual({ kind: 'already_settled' });
    expect((await ledgerOf(user)).filter((l) => l.kind === 'payout')).toHaveLength(1);
    expect(await balance(user)).toBe(9000 + 1870);
  });

  it('does not settle before expiry', async () => {
    clock = Date.now();
    await setPrice('100.00000000');
    const user = await newUser(5000);
    const { order } = await svc.create(user, input(), key());
    expect(await settleOrder(pool, order.id, Date.now())).toEqual({ kind: 'not_due' });
    expect(await orderRow(order.id)).toBe('open');
    expect(await settleOrder(pool, randomUUID(), Date.now())).toEqual({ kind: 'missing' });
  });
});

/**
 * A manipulação vale para todo mundo: o fechamento é o preço da tela, não o real. Quem entrou antes
 * do override, quem entrou no meio da rampa e quem apostou contra o mercado real são todos decididos
 * pelo valor mostrado.
 */
describe('settlement on a manipulated candle', () => {
  /**
   * `shownOpen` é o preço que a tela mostra na abertura da ordem (já com `ov`), `close` é o valor
   * mostrado no vencimento e `real` é o que a Binance fez de verdade.
   * `beforeOv`: a ordem é aberta no preço natural, antes de o override existir.
   */
  async function manipulated(o: Partial<CreateOrderInput>, shownOpen: string, close: string, real: string, beforeOv = false) {
    await pool.query('delete from price_snapshots where asset_id = $1', [assetId]);
    const realNow = Date.now();
    clock = longAgo(realNow);
    await setPrice('100.00000000');
    const user = await newUser(10_000);
    const { order } = await svc.create(user, input(o), key());
    const expires = Date.parse(order.expiresAt);
    const ov = await overrideRow(close, expires);
    if (!beforeOv) {
      await setPrice(shownOpen, clock, { ov, realPrice: real });
      const { rows } = await pool.query<{ id: string }>(
        `update orders set open_price = $2, override_id = $3 where id = $1 returning id`,
        [order.id, shownOpen, ov],
      );
      expect(rows[0]?.id).toBe(order.id);
    }
    clock = realNow;
    await snapshot(close, expires - 500, real);
    return { user, order, expires, now: realNow, ov };
  }

  it('call wins on the shown close even when the real price fell (red candle painted green)', async () => {
    const { user, order, now, ov } = await manipulated({ direction: 'call' }, '100.50000000', '101.00000000', '99.50000000');
    expect(await settleOrder(pool, order.id, now)).toMatchObject({ kind: 'settled', status: 'won', creditCents: 1870 });
    const { rows } = await pool.query<{ close_price: string; override_id: string }>(
      'select close_price::text, override_id::text from orders where id = $1',
      [order.id],
    );
    expect(rows[0]).toEqual({ close_price: '101.00000000', override_id: ov });
    expect(await balance(user)).toBe(10_000 - 1000 + 1870);
  });

  it('an order opened before the override is also decided by the screen', async () => {
    const { order, now } = await manipulated({ direction: 'call' }, '100.00000000', '101.00000000', '99.50000000', true);
    const { rows } = await pool.query<{ override_id: string | null }>('select override_id::text from orders where id = $1', [order.id]);
    expect(rows[0]?.override_id).toBeNull();
    expect(await settleOrder(pool, order.id, now)).toMatchObject({ status: 'won' });
  });

  it('put loses on the shown close even when the real price would have won it', async () => {
    const { order, now } = await manipulated({ direction: 'put' }, '100.50000000', '101.00000000', '99.50000000');
    expect(await settleOrder(pool, order.id, now)).toMatchObject({ status: 'lost', creditCents: 0 });
  });

  it('the same rule downwards: green real candle painted red', async () => {
    const { order, now } = await manipulated({ direction: 'put' }, '100.50000000', '99.00000000', '100.70000000');
    expect(await settleOrder(pool, order.id, now)).toMatchObject({ status: 'won', creditCents: 1870 });
    const { rows } = await pool.query<{ close_price: string }>('select close_price::text from orders where id = $1', [order.id]);
    expect(rows[0]?.close_price).toBe('99.00000000');
  });

  it('the close is still the shown price when the release already started', async () => {
    // 1,5 s de release: no vencimento o preço já voltou parte do caminho, e é isso que a tela mostra.
    const { order, expires, now, ov } = await manipulated({ direction: 'call' }, '100.50000000', '101.00000000', '99.50000000');
    await pool.query('delete from price_snapshots where asset_id = $1', [assetId]);
    await snapshot('100.80000000', expires - 200, '99.50000000');
    expect(await settleOrder(pool, order.id, now)).toMatchObject({ status: 'won' });
    const { rows } = await pool.query<{ close_price: string; override_id: string }>(
      'select close_price::text, override_id::text from orders where id = $1',
      [order.id],
    );
    expect(rows[0]).toEqual({ close_price: '100.80000000', override_id: ov });
  });
});

describe('settlement worker', () => {
  it('settles due orders from the queue and recovers ones missing from Redis via the sweep', async () => {
    await pool.query('delete from price_snapshots where asset_id = $1', [assetId]);
    const realNow = Date.now();
    clock = longAgo(realNow);
    await setPrice('100.00000000');
    const user = await newUser(10_000);
    const a = (await svc.create(user, input(), key())).order;
    const b = (await svc.create(user, input({ direction: 'put' }), key())).order;
    clock = realNow;
    await snapshot('110.00000000', Date.parse(a.expiresAt) - 300);
    // Simulate a lost ZADD for b.
    await redis.zrem(QUEUE, b.id);

    const worker = new SettlementWorker({ pool, queue: redisDueQueue(redis, QUEUE), log, metrics: new Registry() }, WORKER_DEFAULTS);
    expect(await worker.round()).toBeGreaterThanOrEqual(1);
    expect(await redis.zscore(QUEUE, a.id)).toBeNull();
    const { rows } = await pool.query<{ id: string; status: string }>('select id, status from orders where id = any($1::uuid[])', [
      [a.id, b.id],
    ]);
    if (rows.length !== 2) throw new Error(JSON.stringify(rows));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [a.id]: 'won', [b.id]: 'open' });

    expect(await worker.sweep()).toBeGreaterThanOrEqual(1);
    expect(await redis.zscore(QUEUE, b.id)).not.toBeNull();
    await worker.round();
    const after = await pool.query<{ status: string }>('select status from orders where id = $1', [b.id]);
    expect(after.rows[0]?.status).toBe('lost');
    expect(await balance(user)).toBe(10_000 - 2000 + 1870);
  });
});

describe('HTTP flow', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const assets = createAssetRepo(pool, { ttlMs: 0 });
    app = await testApp({
      redis,
      nameSpace: RL_NS,
      deps: {
        auth: createAuthService(pool),
        orders: service(),
        wallet: createWalletService(pool),
        assets,
        limits: createOrderLimitsRepo(pool, { ttlMs: 0 }),
        metrics: new Registry(),
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('register → login → credit → order → wallet, orders and ledger pages', async () => {
    const jar = new CookieJar();
    const send = async (method: 'GET' | 'POST', url: string, payload?: object, extra: Record<string, string> = {}) => {
      const res = await app.inject({
        method,
        url,
        remoteAddress: '10.9.9.9',
        headers: { cookie: jar.header(), 'x-csrf-token': jar.get('__Host-csrf') ?? '', ...extra },
        ...(payload ? { payload } : {}),
      });
      jar.store(res.headers['set-cookie']);
      return res;
    };
    await send('GET', '/api/auth/csrf');
    const email = `http-${randomUUID()}@${DOMAIN}`;
    expect((await send('POST', '/api/auth/register', { email, password: 'senha-forte-123', name: 'Http' })).statusCode).toBe(201);
    expect((await send('POST', '/api/auth/login', { email, password: 'senha-forte-123' })).statusCode).toBe(200);
    const me = (await send('GET', '/api/me')).json<{ user: { id: string } }>().user.id;
    await credit(me, 10_000);

    const assets = (await send('GET', '/api/assets')).json<{ assets: Array<{ id: number; symbol: string }> }>().assets;
    expect(assets.find((a) => a.symbol === SYMBOL)?.id).toBe(assetId);

    clock = Date.now();
    await setPrice('75552.63000000');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      clock += 10; // distinct opens_at, so the list order is deterministic
      const res = await send('POST', '/api/orders', input({ stakeCents: 1000 + i }), {
        'idempotency-key': `http-order-${i}-${me.slice(0, 8)}`,
      });
      expect(res.statusCode).toBe(201);
      ids.push(res.json<{ order: OrderView }>().order.id);
    }
    const replay = await send('POST', '/api/orders', input({ stakeCents: 1000 }), { 'idempotency-key': `http-order-0-${me.slice(0, 8)}` });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ order: OrderView }>().order.id).toBe(ids[0]);

    const wallet = (await send('GET', '/api/wallet')).json<{ wallet: { balanceCents: number; openOrders: number } }>().wallet;
    expect(wallet).toMatchObject({ balanceCents: 10_000 - 3003, openOrders: 3 });

    const p1 = (await send('GET', '/api/orders?limit=2')).json<{ items: OrderView[]; nextCursor: string | null }>();
    expect(p1.items.map((o) => o.id)).toEqual([ids[2], ids[1]]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = (await send('GET', `/api/orders?limit=2&cursor=${p1.nextCursor}`)).json<{ items: OrderView[]; nextCursor: string | null }>();
    expect(p2.items.map((o) => o.id)).toEqual([ids[0]]);
    expect(p2.nextCursor).toBeNull();
    expect((await send('GET', '/api/orders?status=won')).json<{ items: unknown[] }>().items).toEqual([]);

    const l1 = (await send('GET', '/api/ledger?limit=3')).json<{
      items: Array<{ kind: string; deltaCents: number }>;
      nextCursor: string;
    }>();
    expect(l1.items.map((x) => x.deltaCents)).toEqual([-1002, -1001, -1000]);
    const l2 = (await send('GET', `/api/ledger?limit=3&cursor=${l1.nextCursor}`)).json<{
      items: Array<{ kind: string }>;
      nextCursor: string | null;
    }>();
    expect(l2).toMatchObject({ items: [{ kind: 'credit' }], nextCursor: null });

    expect((await send('GET', '/api/orders?cursor=garbage')).statusCode).toBe(400);
  });
});
