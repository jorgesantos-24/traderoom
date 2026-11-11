// Requires `npm run dev:deps` and `npm run db:migrate` first.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { Registry, type AdminAssetView, type AdminUserView, type AuditEntryView, type Page } from '@traderoom/shared';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/lib/db.js';
import { createRedis } from '../src/lib/redis.js';
import { createAdminService, likePattern, type AdminService } from '../src/services/admin.js';
import { createAssetRepo } from '../src/services/assets.js';
import { createAuthService } from '../src/services/auth.js';
import { createWalletService } from '../src/services/wallet.js';
import { CookieJar, testApp } from './helpers.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const DOMAIN = 'admin-int.traderoom.test';
const SYMBOL = 'ZZADMUSDT';
const RL_NS = `rl-admin-int-${randomUUID()}:`;
const PASSWORD = 'senha-forte-123';

let pool: pg.Pool;
let redis: Redis;
let svc: AdminService;
let assetId: number;
let invalidations = 0;
const ik = () => `ik-${randomUUID()}`;

async function newUser(name = 'Pessoa', email = `u-${randomUUID()}@${DOMAIN}`): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(`insert into users (email, password_hash, name) values ($1, '!', $2) returning id`, [
    email,
    name,
  ]);
  const id = rows[0]?.id ?? '';
  await pool.query('insert into accounts (user_id) values ($1)', [id]);
  return id;
}

async function auditOf(adminId: string): Promise<Array<{ action: string; payload: Record<string, unknown> }>> {
  const { rows } = await pool.query<{ action: string; payload: Record<string, unknown> }>(
    'select action, payload from admin_audit where admin_id = $1 order by id',
    [adminId],
  );
  return rows;
}

beforeAll(async () => {
  pool = createPool(config);
  redis = createRedis(config);
  svc = createAdminService({ pool, onAssetsChanged: () => invalidations++ });
  const { rows } = await pool.query<{ id: number }>(
    `insert into assets (symbol, display, binance_stream, payout_pct, enabled, sort)
     values ($1, 'ZZADM/USD', 'zzadmusdt@bookTicker', 80, true, 9997)
     on conflict (symbol) do update set enabled = true, payout_pct = 80 returning id`,
    [SYMBOL],
  );
  assetId = rows[0]?.id ?? 0;
});

afterAll(async () => {
  const users = `select id from users where email like '%@${DOMAIN}'`;
  await pool.query(`delete from admin_audit where admin_id in (${users})`);
  await pool.query(`delete from ledger where user_id in (${users})`);
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`]);
  await pool.query('delete from assets where id = $1', [assetId]);
  await pool.end();
  redis.disconnect();
});

describe('likePattern', () => {
  it('escapes wildcards', () => {
    expect(likePattern('a_b%c\\')).toBe('%a\\_b\\%c\\\\%');
  });
});

describe('adjustBalance', () => {
  it('credits and debits through the ledger with one audit row each', async () => {
    const admin = await newUser('Admin');
    const user = await newUser('Cliente');
    const c = await svc.adjustBalance(admin, user, 10_000, 'Depósito via PIX', ik());
    expect(c.user.balanceCents).toBe(10_000);
    const d = await svc.adjustBalance(admin, user, -2_500, 'Estorno parcial', ik());
    expect(d.user.balanceCents).toBe(7_500);

    const { rows } = await pool.query<{ kind: string; delta_cents: string; balance_after: string; note: string }>(
      'select kind, delta_cents, balance_after, note from ledger where user_id = $1 order by id',
      [user],
    );
    expect(rows.map((r) => [r.kind, Number(r.delta_cents), Number(r.balance_after), r.note])).toEqual([
      ['credit', 10_000, 10_000, 'Depósito via PIX'],
      ['debit', -2_500, 7_500, 'Estorno parcial'],
    ]);
    const log = await auditOf(admin);
    expect(log.map((l) => l.action)).toEqual(['user.credit', 'user.debit']);
    expect(log[1]?.payload).toMatchObject({
      userId: user,
      deltaCents: -2500,
      balanceBefore: 10_000,
      balanceAfter: 7_500,
      note: 'Estorno parcial',
      ledgerId: d.ledgerId,
    });
  });

  it('refuses a debit below zero and leaves no trace', async () => {
    const admin = await newUser('Admin');
    const user = await newUser();
    await svc.adjustBalance(admin, user, 1_000, 'Crédito', ik());
    await expect(svc.adjustBalance(admin, user, -1_001, 'Débito grande', ik())).rejects.toMatchObject({
      statusCode: 400,
      code: 'insufficient_balance',
    });
    const { rows } = await pool.query<{ n: string }>('select count(*) as n from ledger where user_id = $1', [user]);
    expect(Number(rows[0]?.n)).toBe(1);
    expect((await auditOf(admin)).map((l) => l.action)).toEqual(['user.credit']);
  });

  it('keeps every concurrent adjustment (account row lock)', async () => {
    const admin = await newUser('Admin');
    const user = await newUser();
    await Promise.all(Array.from({ length: 20 }, (_, i) => svc.adjustBalance(admin, user, 100 + i, `lote ${i}`, ik())));
    const { rows } = await pool.query<{ b: string }>('select balance_cents as b from accounts where user_id = $1', [user]);
    expect(Number(rows[0]?.b)).toBe(20 * 100 + 190);
    // balance_after forms an unbroken chain.
    const led = await pool.query<{ delta_cents: string; balance_after: string }>(
      'select delta_cents, balance_after from ledger where user_id = $1 order by id',
      [user],
    );
    let running = 0;
    for (const r of led.rows) {
      running += Number(r.delta_cents);
      expect(Number(r.balance_after)).toBe(running);
    }
  });

  it('replays a retried request, rejects key reuse, and survives a burst of parallel retries', async () => {
    const admin = await newUser('Admin');
    const user = await newUser();
    const key = ik();
    const first = await svc.adjustBalance(admin, user, 3_000, 'Crédito único', key);
    const again = await svc.adjustBalance(admin, user, 3_000, 'Crédito único', key);
    expect(first.replayed).toBe(false);
    expect(again).toMatchObject({ replayed: true, ledgerId: first.ledgerId, user: { balanceCents: 3_000 } });
    await expect(svc.adjustBalance(admin, user, 3_001, 'Crédito único', key)).rejects.toMatchObject({
      statusCode: 409,
      code: 'idempotency_conflict',
    });
    const other = await newUser();
    await expect(svc.adjustBalance(admin, other, 3_000, 'Crédito único', key)).rejects.toMatchObject({ statusCode: 409 });
    // Another admin may use the same key value: keys are per admin.
    const admin2 = await newUser('Admin 2');
    expect((await svc.adjustBalance(admin2, user, 3_000, 'Crédito único', key)).replayed).toBe(false);

    const burstKey = ik();
    const results = await Promise.all(Array.from({ length: 10 }, () => svc.adjustBalance(admin, other, 700, 'Rajada', burstKey)));
    expect(new Set(results.map((r) => r.ledgerId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const { rows } = await pool.query<{ b: string }>('select balance_cents as b from accounts where user_id = $1', [other]);
    expect(Number(rows[0]?.b)).toBe(700);
    expect((await auditOf(admin)).filter((l) => l.action === 'user.credit')).toHaveLength(2);
  });

  it('404s an unknown user', async () => {
    const admin = await newUser('Admin');
    await expect(svc.adjustBalance(admin, randomUUID(), 100, 'nada', ik())).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('setBlocked', () => {
  it('blocks (dropping sessions), unblocks, and audits only real changes', async () => {
    const admin = await newUser('Admin');
    const user = await newUser();
    await pool.query(`insert into sessions (user_id, token_hash, expires_at) values ($1, 'x', now() + interval '1 day')`, [user]);
    expect((await svc.setBlocked(admin, user, true)).status).toBe('blocked');
    expect((await svc.setBlocked(admin, user, true)).status).toBe('blocked');
    const s = await pool.query<{ n: string }>('select count(*) as n from sessions where user_id = $1', [user]);
    expect(Number(s.rows[0]?.n)).toBe(0);
    expect((await svc.setBlocked(admin, user, false)).status).toBe('active');
    expect((await auditOf(admin)).map((l) => l.action)).toEqual(['user.block', 'user.unblock']);
  });

  it('will not block yourself', async () => {
    const admin = await newUser('Admin');
    await expect(svc.setBlocked(admin, admin, true)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('listUsers', () => {
  it('searches e-mail and name, case-insensitively, with keyset pages', async () => {
    const tag = randomUUID().slice(0, 8);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await newUser(`Busca ${tag} ${i}`));
    await newUser('Outro', `${tag}-mail@${DOMAIN}`);
    const all = await svc.listUsers({ q: tag.toUpperCase(), limit: 50 });
    expect(all.items).toHaveLength(4);
    const p1 = await svc.listUsers({ q: `busca ${tag}`, limit: 2 });
    expect(p1.items).toHaveLength(2);
    const p2 = await svc.listUsers({ q: `busca ${tag}`, limit: 2, cursor: p1.nextCursor ?? undefined });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((u) => u.id))).toEqual(new Set(ids));
    expect(p1.items[0]).toMatchObject({ role: 'user', status: 'active', balanceCents: 0, openOrders: 0 });
    expect((await svc.listUsers({ q: '%', limit: 5 })).items.every((u) => u.email.includes('%') || u.name.includes('%'))).toBe(true);
  });
});

describe('updateAsset', () => {
  it('changes payout and enabled, audits before/after and invalidates the cache', async () => {
    const admin = await newUser('Admin');
    const before = invalidations;
    const a = await svc.updateAsset(admin, assetId, { payoutPct: 91 });
    expect(a).toMatchObject({ id: assetId, payoutPct: 91, enabled: true });
    const b = await svc.updateAsset(admin, assetId, { enabled: false });
    expect(b.enabled).toBe(false);
    await svc.updateAsset(admin, assetId, { enabled: false }); // no-op: no audit row
    expect(invalidations).toBe(before + 3);
    const log = await auditOf(admin);
    expect(log).toEqual([
      {
        action: 'asset.update',
        payload: { assetId, symbol: SYMBOL, before: { payoutPct: 80, enabled: true }, after: { payoutPct: 91, enabled: true } },
      },
      {
        action: 'asset.update',
        payload: { assetId, symbol: SYMBOL, before: { payoutPct: 91, enabled: true }, after: { payoutPct: 91, enabled: false } },
      },
    ]);
    expect((await svc.listAssets()).find((x) => x.id === assetId)).toMatchObject({ payoutPct: 91, enabled: false });
    await expect(svc.updateAsset(admin, 999_999, { enabled: true })).rejects.toMatchObject({ statusCode: 404 });
    // A DB check rejects anything the schema let through by mistake.
    await expect(pool.query('update assets set payout_pct = 99 where id = $1', [assetId])).rejects.toThrow();
    await svc.updateAsset(admin, assetId, { payoutPct: 80, enabled: true });
  });
});

describe('HTTP: /api/admin/*', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const assets = createAssetRepo(pool, { ttlMs: 60_000 });
    app = await testApp({
      redis,
      nameSpace: RL_NS,
      deps: {
        auth: createAuthService(pool),
        wallet: createWalletService(pool),
        assets,
        admin: createAdminService({ pool, onAssetsChanged: () => assets.invalidate() }),
        metrics: new Registry(),
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  function client() {
    const jar = new CookieJar();
    return async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, extra: Record<string, string> = {}) => {
      const res = await app.inject({
        method,
        url,
        remoteAddress: '10.8.8.8',
        headers: { cookie: jar.header(), 'x-csrf-token': jar.get('__Host-csrf') ?? '', ...extra },
        ...(payload ? { payload } : {}),
      });
      jar.store(res.headers['set-cookie']);
      return res;
    };
  }

  async function signedIn(role: 'user' | 'admin') {
    const send = client();
    const email = `${role}-${randomUUID()}@${DOMAIN}`;
    await send('GET', '/api/auth/csrf');
    expect((await send('POST', '/api/auth/register', { email, password: PASSWORD, name: role })).statusCode).toBe(201);
    if (role === 'admin') await pool.query(`update users set role = 'admin' where email = $1`, [email]);
    expect((await send('POST', '/api/auth/login', { email, password: PASSWORD })).statusCode).toBe(200);
    const id = (await send('GET', '/api/me')).json<{ user: { id: string } }>().user.id;
    return { send, id, email };
  }

  it('refuses anonymous (401) and regular users (403) on every route', async () => {
    const anon = client();
    await anon('GET', '/api/auth/csrf'); // valid CSRF pair, no session: must hit the auth check
    const user = await signedIn('user');
    const routes: Array<['GET' | 'POST' | 'PATCH', string, object?]> = [
      ['GET', '/api/admin/users'],
      ['POST', `/api/admin/users/${user.id}/credit`, { deltaCents: 100, note: 'x'.repeat(5) }],
      ['POST', `/api/admin/users/${user.id}/block`, {}],
      ['GET', '/api/admin/assets'],
      ['PATCH', `/api/admin/assets/${assetId}`, { payoutPct: 90 }],
      ['GET', '/api/admin/audit'],
    ];
    for (const [m, url, body] of routes) {
      expect((await anon(m, url, body)).statusCode, `${m} ${url} anon`).toBe(401);
      const res = await user.send(m, url, body);
      expect(res.statusCode, `${m} ${url} user`).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: 'forbidden' } });
    }
  });

  it('credit → block (session dies) → unblock → asset edit → audit page', async () => {
    const admin = await signedIn('admin');
    const target = await signedIn('user');

    const noKey = await admin.send('POST', `/api/admin/users/${target.id}/credit`, { deltaCents: 100, note: 'sem chave' });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json<{ error: { message: string } }>().error.message).toContain('Idempotency-Key');
    const key = { 'idempotency-key': ik() };
    const bad = await admin.send('POST', `/api/admin/users/${target.id}/credit`, { deltaCents: 0, note: 'ok ok' }, key);
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: { message: string } }>().error.message).toContain('zero');
    expect((await admin.send('POST', '/api/admin/users/not-a-uuid/credit', { deltaCents: 1, note: 'abc' }, key)).statusCode).toBe(400);

    const cr = await admin.send('POST', `/api/admin/users/${target.id}/credit`, { deltaCents: 5_000, note: 'Bônus de boas-vindas' }, key);
    expect(cr.statusCode).toBe(200);
    expect(cr.headers['idempotency-replayed']).toBe('false');
    const retry = await admin.send(
      'POST',
      `/api/admin/users/${target.id}/credit`,
      { deltaCents: 5_000, note: 'Bônus de boas-vindas' },
      key,
    );
    expect(retry.headers['idempotency-replayed']).toBe('true');
    expect(retry.json<{ ledgerId: string }>().ledgerId).toBe(cr.json<{ ledgerId: string }>().ledgerId);
    expect(cr.json<{ user: AdminUserView }>().user.balanceCents).toBe(5_000);
    expect((await target.send('GET', '/api/wallet')).json<{ wallet: { balanceCents: number } }>().wallet.balanceCents).toBe(5_000);

    const found = (await admin.send('GET', `/api/admin/users?q=${encodeURIComponent(target.email)}`)).json<Page<AdminUserView>>();
    expect(found.items.map((u) => u.id)).toEqual([target.id]);

    const blocked = await admin.send('POST', `/api/admin/users/${target.id}/block`);
    expect(blocked.json<{ user: AdminUserView }>().user.status).toBe('blocked');
    expect((await target.send('GET', '/api/me')).statusCode).toBe(401);
    const login = await client()('POST', '/api/auth/login', { email: target.email, password: PASSWORD });
    expect(login.json()).toMatchObject({ error: { code: 'account_blocked' } });
    const unblocked = await admin.send('POST', `/api/admin/users/${target.id}/block`, { blocked: false });
    expect(unblocked.json<{ user: AdminUserView }>().user.status).toBe('active');
    expect((await admin.send('POST', `/api/admin/users/${admin.id}/block`, {})).statusCode).toBe(400);
    // Blocking ended the old session for good; after unblocking, a fresh login works.
    expect((await target.send('GET', '/api/me')).statusCode).toBe(401);
    expect((await target.send('POST', '/api/auth/login', { email: target.email, password: PASSWORD })).statusCode).toBe(200);

    // The public asset list reflects the change at once (cache invalidated in-process).
    expect((await admin.send('PATCH', `/api/admin/assets/${assetId}`, { payoutPct: 120 })).statusCode).toBe(400);
    expect((await admin.send('PATCH', `/api/admin/assets/${assetId}`, {})).statusCode).toBe(400);
    expect((await admin.send('PATCH', `/api/admin/assets/${assetId}`, { payoutPct: 85, symbol: 'X' })).statusCode).toBe(400);
    const pub = async () =>
      (await target.send('GET', '/api/assets')).json<{ assets: Array<{ symbol: string; payoutPct: number }> }>().assets;
    await pub(); // warm the cache
    const patched = await admin.send('PATCH', `/api/admin/assets/${assetId}`, { payoutPct: 85 });
    expect(patched.json<{ asset: AdminAssetView }>().asset.payoutPct).toBe(85);
    expect((await pub()).find((a) => a.symbol === SYMBOL)?.payoutPct).toBe(85);
    await admin.send('PATCH', `/api/admin/assets/${assetId}`, { enabled: false });
    expect((await pub()).some((a) => a.symbol === SYMBOL)).toBe(false);
    const adminAssets = (await admin.send('GET', '/api/admin/assets')).json<{ assets: AdminAssetView[] }>().assets;
    expect(adminAssets.find((a) => a.id === assetId)).toMatchObject({ enabled: false, payoutPct: 85 });
    await admin.send('PATCH', `/api/admin/assets/${assetId}`, { enabled: true, payoutPct: 80 });

    const p1 = (await admin.send('GET', '/api/admin/audit?limit=3')).json<Page<AuditEntryView>>();
    expect(p1.items.map((e) => e.action)).toEqual(['asset.update', 'asset.update', 'asset.update']);
    expect(p1.items[0]?.adminEmail).toBe(admin.email);
    const p2 = (await admin.send('GET', `/api/admin/audit?limit=3&cursor=${p1.nextCursor}`)).json<Page<AuditEntryView>>();
    expect(p2.items.map((e) => e.action)).toEqual(['user.unblock', 'user.block', 'user.credit']);
    const credits = (await admin.send('GET', '/api/admin/audit?action=user.credit&limit=100')).json<Page<AuditEntryView>>();
    expect(credits.items.find((e) => e.adminId === admin.id)?.payload).toMatchObject({ userId: target.id, deltaCents: 5_000 });
    expect((await admin.send('GET', '/api/admin/audit?action=drop.table')).statusCode).toBe(400);
  });
});

describe('premium indicator access', () => {
  it('grants by e-mail once, lists, revokes, and audits each real change; admins always have it', async () => {
    const adminId = await newUser('Admin Ind', `adm-ind-${randomUUID()}@${DOMAIN}`);
    const email = `Ind-${randomUUID()}@${DOMAIN}`;
    const userId = await newUser('Cliente Ind', email);
    expect(await svc.allowedIndicators(userId, 'user')).toEqual([]);
    expect(await svc.allowedIndicators(userId, 'admin')).toEqual(['smc', 'patterns']);

    // Case-insensitive e-mail; a second grant changes nothing.
    const first = await svc.grantIndicator(adminId, email.toUpperCase(), 'smc');
    expect(first).toMatchObject({ userId, indicator: 'smc', name: 'Cliente Ind' });
    await svc.grantIndicator(adminId, email, 'smc');
    await svc.grantIndicator(adminId, email, 'patterns');
    expect((await svc.allowedIndicators(userId, 'user')).sort()).toEqual(['patterns', 'smc']);
    const mine = (await svc.listIndicatorAccess()).filter((a) => a.userId === userId);
    expect(mine.map((a) => a.indicator).sort()).toEqual(['patterns', 'smc']);
    expect(mine[0]!.grantedByEmail).toMatch(/^adm-ind-/);

    await svc.revokeIndicator(adminId, userId, 'smc');
    expect(await svc.allowedIndicators(userId, 'user')).toEqual(['patterns']);
    await expect(svc.revokeIndicator(adminId, userId, 'smc')).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.grantIndicator(adminId, `nobody-${randomUUID()}@${DOMAIN}`, 'smc')).rejects.toMatchObject({ statusCode: 404 });

    expect((await auditOf(adminId)).map((r) => [r.action, r.payload.indicator])).toEqual([
      ['indicator.grant', 'smc'],
      ['indicator.grant', 'patterns'],
      ['indicator.revoke', 'smc'],
    ]);
  });
});
