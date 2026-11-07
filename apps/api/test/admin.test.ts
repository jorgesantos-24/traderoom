import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Registry, type AdminUserView } from '@traderoom/shared';
import type { AdminService } from '../src/services/admin.js';
import { FAKE_ADMIN_SID, FAKE_SID, TEST_USER, testApp, unusedAdmin } from './helpers.js';

const CSRF = 'c'.repeat(43);
const TARGET = '99999999-9999-4999-8999-999999999999';
const USER_VIEW: AdminUserView = {
  id: TARGET,
  email: 'bia@example.com',
  name: 'Bia',
  role: 'user',
  status: 'active',
  createdAt: '2026-11-06T15:00:00.000000Z',
  balanceCents: 1000,
  openOrders: 0,
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(overrides: Partial<AdminService> = {}, metrics = new Registry()) {
  const calls: unknown[][] = [];
  const admin: AdminService = {
    ...unusedAdmin,
    listUsers: async (q) => {
      calls.push(['listUsers', q]);
      return { items: [USER_VIEW], nextCursor: null };
    },
    adjustBalance: async (...args) => {
      calls.push(['adjustBalance', ...args]);
      return { user: { ...USER_VIEW, balanceCents: 1000 + args[2] }, ledgerId: '7', replayed: false };
    },
    setBlocked: async (...args) => {
      calls.push(['setBlocked', ...args]);
      return { ...USER_VIEW, status: args[2] ? 'blocked' : 'active' };
    },
    updateAsset: async (...args) => {
      calls.push(['updateAsset', ...args]);
      return { id: args[1], symbol: 'BTCUSDT', display: 'BTC/USD', payoutPct: 90, enabled: true, sort: 0, kind: 'market', category: 'crypto', otcVolPctHour: null, otcDriftPctHour: 0 };
    },
    listAudit: async (q) => {
      calls.push(['listAudit', q]);
      return { items: [], nextCursor: null };
    },
    ...overrides,
  };
  app = await testApp({ deps: { admin, metrics } });
  return { app, calls };
}

const KEY = 'admin-key-0001';

function req(a: FastifyInstance, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, sid = FAKE_ADMIN_SID) {
  return a.inject({
    method,
    url,
    headers: { cookie: `sid=${sid}; __Host-csrf=${CSRF}`, 'x-csrf-token': CSRF, 'idempotency-key': KEY },
    ...(payload ? { payload } : {}),
  });
}

describe('admin routes', () => {
  it('forbid regular users', async () => {
    const { app, calls } = await build();
    for (const [m, url] of [
      ['GET', '/api/admin/users'],
      ['GET', '/api/admin/audit'],
      ['GET', '/api/admin/assets'],
    ] as const) {
      expect((await req(app, m, url, undefined, FAKE_SID)).statusCode).toBe(403);
    }
    expect((await req(app, 'POST', `/api/admin/users/${TARGET}/credit`, { deltaCents: 1, note: 'abc' }, FAKE_SID)).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('passes the session admin id, never one from the body', async () => {
    const metrics = new Registry();
    const { app, calls } = await build({}, metrics);
    const res = await req(app, 'POST', `/api/admin/users/${TARGET}/credit`, { deltaCents: -250, note: '  Ajuste  ', adminId: 'x' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { balanceCents: 750 }, ledgerId: '7' });
    expect(calls).toEqual([['adjustBalance', TEST_USER.id, TARGET, -250, 'Ajuste', KEY]]);
    expect(res.headers['idempotency-replayed']).toBe('false');
    expect(metrics.render()).toContain('admin_actions_total{action="user.debit"} 1');
  });

  it.each([
    [{ deltaCents: 0, note: 'abc' }, 'zero'],
    [{ deltaCents: 1.5, note: 'abc' }, 'centavos'],
    [{ deltaCents: 100, note: 'ab' }, 'motivo'],
    [{ deltaCents: 100 }, 'motivo'],
    [{ deltaCents: 200_000_000, note: 'abc' }, 'máximo'],
  ])('validates credit body %j', async (body, msg) => {
    const { app, calls } = await build();
    const res = await req(app, 'POST', `/api/admin/users/${TARGET}/credit`, body);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain(msg);
    expect(calls).toEqual([]);
  });

  it('blocks by default and unblocks with blocked:false', async () => {
    const { app, calls } = await build();
    expect((await req(app, 'POST', `/api/admin/users/${TARGET}/block`)).json()).toMatchObject({ user: { status: 'blocked' } });
    expect((await req(app, 'POST', `/api/admin/users/${TARGET}/block`, { blocked: false })).json()).toMatchObject({ user: { status: 'active' } });
    expect((await req(app, 'POST', `/api/admin/users/${TARGET}/block`, { blocked: 'yes' })).statusCode).toBe(400);
    expect((await req(app, 'POST', '/api/admin/users/123/block')).statusCode).toBe(400);
    expect(calls).toEqual([
      ['setBlocked', TEST_USER.id, TARGET, true],
      ['setBlocked', TEST_USER.id, TARGET, false],
    ]);
  });

  it('validates asset patches', async () => {
    const { app, calls } = await build();
    expect((await req(app, 'PATCH', '/api/admin/assets/3', { payoutPct: 90 })).statusCode).toBe(200);
    for (const body of [{}, { payoutPct: 49 }, { payoutPct: 96 }, { payoutPct: 90.5 }, { enabled: 'no' }, { symbol: 'X', enabled: true }]) {
      expect((await req(app, 'PATCH', '/api/admin/assets/3', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await req(app, 'PATCH', '/api/admin/assets/abc', { enabled: true })).statusCode).toBe(400);
    expect(calls).toEqual([['updateAsset', TEST_USER.id, 3, { payoutPct: 90 }]]);
  });

  it('validates list queries', async () => {
    const { app, calls } = await build();
    expect((await req(app, 'GET', '/api/admin/users?q=%20bia%20&limit=10')).statusCode).toBe(200);
    expect((await req(app, 'GET', '/api/admin/audit?action=user.block')).statusCode).toBe(200);
    expect((await req(app, 'GET', '/api/admin/audit?action=nope')).statusCode).toBe(400);
    expect((await req(app, 'GET', '/api/admin/users?limit=1000')).statusCode).toBe(400);
    expect(calls).toEqual([
      ['listUsers', { q: 'bia', limit: 10 }],
      ['listAudit', { action: 'user.block', limit: 50 }],
    ]);
  });

  it('needs CSRF on writes', async () => {
    const { app, calls } = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${TARGET}/block`,
      headers: { cookie: `sid=${FAKE_ADMIN_SID}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'csrf_failed' } });
    expect(calls).toEqual([]);
  });
});
