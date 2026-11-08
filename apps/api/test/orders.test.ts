import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Registry, type CreateOrderInput, type OrderView } from '@traderoom/shared';
import { AppError } from '../src/lib/errors.js';
import type { OrderService } from '../src/services/orders.js';
import type { WalletService } from '../src/services/wallet.js';
import { fakeAuth, FAKE_ADMIN_SID, FAKE_SID, TEST_USER, testApp } from './helpers.js';

const CSRF = 'c'.repeat(43);
const KEY = 'order-key-0001';
const BODY: CreateOrderInput = { account: 'real', assetId: 1, direction: 'call', stakeCents: 1000, durationSec: 60 };

const ORDER: OrderView = {
  id: '44444444-4444-4444-8444-444444444444',
  account: 'real',
  assetId: 1,
  symbol: 'BTCUSDT',
  direction: 'call',
  stakeCents: 1000,
  payoutPct: 87,
  durationSec: 60,
  openPrice: '75552.63000000',
  closePrice: null,
  status: 'open',
  payoutCents: 0,
  potentialPayoutCents: 1870,
  opensAt: '2026-11-06T15:00:00.000000Z',
  expiresAt: '2026-11-06T15:01:00.000000Z',
  settledAt: null,
  overrideId: null,
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface Calls {
  create: Array<[string, CreateOrderInput, string]>;
  list: unknown[];
}

async function build(overrides: Partial<OrderService> = {}, metrics = new Registry()): Promise<{ app: FastifyInstance; calls: Calls }> {
  const calls: Calls = { create: [], list: [] };
  const orders: OrderService = {
    create: async (userId, input, key) => {
      calls.create.push([userId, input, key]);
      return { order: ORDER, replayed: false };
    },
    list: async (userId, q) => {
      calls.list.push([userId, q]);
      return { items: [ORDER], nextCursor: null };
    },
    ...overrides,
  };
  const wallet: WalletService = {
    all: async () => [],
    refillDemo: async () => {
      throw new Error('not used');
    },
    get: async () => ({ account: 'real', balanceCents: 5000, currency: 'USD', openStakeCents: 1000, openOrders: 1 }),
    ledger: async () => ({ items: [], nextCursor: null }),
  };
  // FAKE_ADMIN_SID resolves to a second, distinct user so per-user limits can be told apart.
  const other = { ...TEST_USER, id: '55555555-5555-4555-8555-555555555555', email: 'bia@example.com' };
  const auth = fakeAuth({
    resolveSession: async (v) =>
      v === FAKE_SID ? { sessionId: 's1', user: TEST_USER } : v === FAKE_ADMIN_SID ? { sessionId: 's2', user: other } : null,
  });
  app = await testApp({ deps: { orders, wallet, metrics, auth } });
  return { app, calls };
}

function post(a: FastifyInstance, opts: { key?: string | null; body?: unknown; sid?: string; csrf?: boolean } = {}) {
  const headers: Record<string, string> = {
    cookie: `sid=${opts.sid ?? FAKE_SID}${opts.csrf === false ? '' : `; __Host-csrf=${CSRF}`}`,
  };
  if (opts.csrf !== false) headers['x-csrf-token'] = CSRF;
  if (opts.key !== null) headers['idempotency-key'] = opts.key ?? KEY;
  return a.inject({ method: 'POST', url: '/api/orders', headers, payload: (opts.body ?? BODY) as object });
}

describe('POST /api/orders', () => {
  it('creates an order for the session user and returns 201', async () => {
    const { app, calls } = await build();
    const res = await post(app);
    expect(res.statusCode).toBe(201);
    expect(res.headers['idempotency-replayed']).toBe('false');
    expect(res.json()).toEqual({ order: ORDER });
    expect(calls.create).toEqual([[TEST_USER.id, BODY, KEY]]);
  });

  it('ignores any user id in the body (the order always belongs to the session)', async () => {
    const { app, calls } = await build();
    await post(app, { body: { ...BODY, userId: 'someone-else' } });
    expect(calls.create[0]?.[0]).toBe(TEST_USER.id);
    expect(calls.create[0]?.[1]).toEqual(BODY);
  });

  it('answers a replay with 200 and the header', async () => {
    const { app } = await build({ create: async () => ({ order: ORDER, replayed: true }) });
    const res = await post(app);
    expect(res.statusCode).toBe(200);
    expect(res.headers['idempotency-replayed']).toBe('true');
  });

  it('requires a session and a CSRF token', async () => {
    const { app } = await build();
    expect((await post(app, { sid: 'nope' })).statusCode).toBe(401);
    expect((await post(app, { csrf: false })).json()).toMatchObject({ error: { code: 'csrf_failed' } });
  });

  it.each([
    ['missing', null],
    ['too short', 'abc'],
    ['bad chars', 'key with spaces!'],
  ])('rejects a %s Idempotency-Key', async (_n, key) => {
    const { app, calls } = await build();
    const res = await post(app, { key });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain('Idempotency-Key');
    expect(calls.create).toEqual([]);
  });

  it.each([
    ['assetId', { ...BODY, assetId: 'BTC' }],
    ['direction', { ...BODY, direction: 'up' }],
    ['stakeCents', { ...BODY, stakeCents: 10.5 }],
    ['stakeCents', { ...BODY, stakeCents: -100 }],
    ['durationSec', { ...BODY, durationSec: undefined }],
  ])('validates %s', async (field, body) => {
    const { app } = await build();
    const res = await post(app, { body });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain(field);
  });

  it.each([
    [400, 'insufficient_balance', 'Saldo insuficiente.'],
    [409, 'asset_stale', 'Cotação defasada.'],
    [409, 'idempotency_conflict', 'Chave reutilizada.'],
    [404, 'unknown_asset', 'Ativo não encontrado.'],
  ])('passes %i %s through and counts it', async (status, code, message) => {
    const metrics = new Registry();
    const { app } = await build(
      {
        create: async () => {
          throw new AppError(status, code, message);
        },
      },
      metrics,
    );
    const res = await post(app);
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: { code, message } });
    expect(metrics.render()).toContain(`orders_rejected_total{code="${code}"} 1`);
  });

  it('limits each user to 30 orders per minute', async () => {
    const { app } = await build();
    for (let i = 0; i < 30; i++) expect((await post(app, { key: `k-${String(i).padStart(8, '0')}` })).statusCode).toBe(201);
    const res = await post(app, { key: 'k-overflow-1' });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: { code: 'rate_limited' } });
    // A different user is not affected.
    expect((await post(app, { sid: FAKE_ADMIN_SID, key: 'k-admin-0001' })).statusCode).toBe(201);
  });
});

describe('GET endpoints', () => {
  it('lists orders with validated filters', async () => {
    const { app, calls } = await build();
    const res = await app.inject({ method: 'GET', url: '/api/orders?status=open&limit=10', headers: { cookie: `sid=${FAKE_SID}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [ORDER], nextCursor: null });
    expect(calls.list).toEqual([[TEST_USER.id, { account: 'real', status: 'open', limit: 10 }]]);
    const bad = await app.inject({ method: 'GET', url: '/api/orders?status=pending', headers: { cookie: `sid=${FAKE_SID}` } });
    expect(bad.statusCode).toBe(400);
  });

  it('returns the wallet, ledger and assets behind auth', async () => {
    const { app } = await build();
    const h = { cookie: `sid=${FAKE_SID}` };
    expect((await app.inject({ method: 'GET', url: '/api/wallet', headers: h })).json()).toEqual({
      wallet: { account: 'real', balanceCents: 5000, currency: 'USD', openStakeCents: 1000, openOrders: 1 },
    });
    expect((await app.inject({ method: 'GET', url: '/api/ledger', headers: h })).json()).toEqual({ items: [], nextCursor: null });
    expect((await app.inject({ method: 'GET', url: '/api/assets', headers: h })).json()).toEqual({
      assets: [{ id: 1, symbol: 'BTCUSDT', display: 'BTC/USD', payoutPct: 87, kind: 'market', category: 'crypto' }],
      limits: { minStakeCents: 100, maxStakeCents: 1_000_000, durationsSec: [60, 300] },
    });
    for (const url of ['/api/wallet', '/api/ledger', '/api/assets', '/api/orders']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
  });
});

describe('GET /metrics', () => {
  it('serves Prometheus text locally and hides from proxied requests', async () => {
    const { app } = await build();
    await post(app);
    const local = await app.inject({ method: 'GET', url: '/metrics' });
    expect(local.statusCode).toBe(200);
    expect(local.body).toContain('orders_created_total{direction="call"} 1');
    expect(local.body).toContain('http_responses_total{status="201"} 1');
    const proxied = await app.inject({ method: 'GET', url: '/metrics', headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect(proxied.statusCode).toBe(404);
  });
});
