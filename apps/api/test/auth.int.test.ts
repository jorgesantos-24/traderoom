// Requires `npm run dev:deps` and `npm run db:migrate` first.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/lib/db.js';
import { createRedis } from '../src/lib/redis.js';
import { sha256Hex } from '../src/lib/tokens.js';
import { createAuthService } from '../src/services/auth.js';
import { captureMailer, CookieJar, testApp, type SentMail } from './helpers.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const DOMAIN = 'int.traderoom.test';
const RL_NS = `rl-int-${randomUUID()}:`;
const config = loadConfig();

let pool: pg.Pool;
let redis: Redis;
let app: FastifyInstance;
let sent: SentMail[];

beforeAll(async () => {
  pool = createPool(config);
  redis = createRedis(config);
  const capture = captureMailer();
  sent = capture.sent;
  app = await testApp({
    deps: { auth: createAuthService(pool) },
    mailer: capture.mailer,
    redis,
    nameSpace: RL_NS,
  });
});

afterAll(async () => {
  await app.close();
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`]);
  const keys = await redis.keys(`${RL_NS}*`);
  if (keys.length > 0) await redis.del(...keys);
  await Promise.all([pool.end(), redis.quit()]);
});

let ipCounter = 0;
/** Each client gets its own IP so rate limits from one test do not leak into another. */
class Client {
  readonly jar = new CookieJar();
  csrf: string | undefined;
  readonly ip = `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

  async req(method: 'GET' | 'POST', url: string, payload?: object): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = {};
    const cookie = this.jar.header();
    if (cookie) headers['cookie'] = cookie;
    if (method === 'POST' && this.csrf) headers['x-csrf-token'] = this.csrf;
    const opts: InjectOptions = { method, url, headers, remoteAddress: this.ip, ...(payload ? { payload } : {}) };
    const res = await app.inject(opts);
    this.jar.store(res.headers['set-cookie']);
    return res;
  }

  async init(): Promise<this> {
    const res = await this.req('GET', '/api/auth/csrf');
    this.csrf = res.json<{ csrfToken: string }>().csrfToken;
    return this;
  }

  async login(email: string, password: string): Promise<LightMyRequestResponse> {
    const res = await this.req('POST', '/api/auth/login', { email, password });
    if (res.statusCode === 200) this.csrf = res.json<{ csrfToken: string }>().csrfToken;
    return res;
  }
}

function newEmail(): string {
  return `u-${randomUUID().slice(0, 8)}@${DOMAIN}`;
}

async function registered(password = 'senha-forte-123'): Promise<{ email: string; password: string; id: string }> {
  const c = await new Client().init();
  const email = newEmail();
  const res = await c.req('POST', '/api/auth/register', { email, password, name: 'Teste' });
  expect(res.statusCode).toBe(201);
  return { email, password, id: res.json<{ user: { id: string } }>().user.id };
}

describe('auth against real Postgres and Redis', () => {
  it('register → login → me → logout', async () => {
    const c = await new Client().init();
    const email = newEmail();

    const reg = await c.req('POST', '/api/auth/register', { email, password: 'senha-forte-123', name: 'Ana' });
    expect(reg.statusCode).toBe(201);
    const { user } = reg.json<{ user: { id: string; email: string; role: string } }>();
    expect(user).toMatchObject({ email, name: 'Ana', role: 'user' });

    const { rows: acct } = await pool.query('select kind, balance_cents, currency from accounts where user_id = $1 order by kind', [
      user.id,
    ]);
    expect(acct).toEqual([
      { kind: 'demo', balance_cents: '1000000', currency: 'USD' },
      { kind: 'real', balance_cents: '0', currency: 'USD' },
    ]);
    const { rows: u } = await pool.query<{ password_hash: string }>('select password_hash from users where id = $1', [
      user.id,
    ]);
    expect(u[0]!.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);

    expect((await c.req('GET', '/api/me')).statusCode).toBe(401);

    const login = await c.login(email, 'senha-forte-123');
    expect(login.statusCode).toBe(200);

    // Only the SHA-256 of the token is stored.
    const [sessionId, token] = c.jar.get('sid')!.split('.');
    const { rows: s } = await pool.query<{ token_hash: string; ttl: number }>(
      `select token_hash, extract(epoch from expires_at - created_at)::int as ttl from sessions where id = $1`,
      [sessionId],
    );
    expect(s[0]!.token_hash).toBe(sha256Hex(token!));
    expect(s[0]!.token_hash).not.toContain(token!);
    expect(s[0]!.ttl).toBe(7 * 24 * 3600);

    const me = await c.req('GET', '/api/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ user: { id: user.id, email, name: 'Ana', role: 'user' } });

    expect((await c.req('POST', '/api/auth/logout')).statusCode).toBe(204);
    expect((await pool.query('select 1 from sessions where id = $1', [sessionId])).rowCount).toBe(0);
    expect((await c.req('GET', '/api/me')).statusCode).toBe(401);
  });

  it('rejects a duplicate e-mail regardless of case', async () => {
    const { email } = await registered();
    const c = await new Client().init();
    const res = await c.req('POST', '/api/auth/register', { email: email.toUpperCase(), password: 'outra-senha-123', name: 'X' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'email_taken' } });
  });

  it('logs in with a differently-cased e-mail', async () => {
    const { email, password } = await registered();
    const c = new Client();
    expect((await c.login(email.toUpperCase(), password)).statusCode).toBe(200);
  });

  it('gives the same 401 for a wrong password and an unknown e-mail', async () => {
    const { email } = await registered();
    const wrong = await new Client().login(email, 'senha-errada-000');
    const unknown = await new Client().login(newEmail(), 'senha-errada-000');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.body).toBe(unknown.body);
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('blocked users cannot log in, and existing sessions stop working', async () => {
    const { email, password, id } = await registered();
    const c = new Client();
    expect((await c.login(email, password)).statusCode).toBe(200);
    expect((await c.req('GET', '/api/me')).statusCode).toBe(200);

    await pool.query(`update users set status = 'blocked' where id = $1`, [id]);
    expect((await c.req('GET', '/api/me')).statusCode).toBe(401);
    const again = await new Client().login(email, password);
    expect(again.statusCode).toBe(403);
    expect(again.json()).toMatchObject({ error: { code: 'account_blocked' } });
  });

  it('expired sessions are rejected and deleted', async () => {
    const { email, password } = await registered();
    const c = new Client();
    await c.login(email, password);
    const sessionId = c.jar.get('sid')!.split('.')[0];
    await pool.query(`update sessions set expires_at = now() - interval '1 second' where id = $1`, [sessionId]);
    expect((await c.req('GET', '/api/me')).statusCode).toBe(401);
    expect((await pool.query('select 1 from sessions where id = $1', [sessionId])).rowCount).toBe(0);
  });

  it('a real session id with a forged token is rejected', async () => {
    const { email, password } = await registered();
    const c = new Client();
    await c.login(email, password);
    const sessionId = c.jar.get('sid')!.split('.')[0];
    const forged = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `sid=${encodeURIComponent(`${sessionId}.${'A'.repeat(43)}`)}` },
    });
    expect(forged.statusCode).toBe(401);
    // And the forged attempt did not destroy the real session.
    expect((await c.req('GET', '/api/me')).statusCode).toBe(200);
  });

  describe('password reset', () => {
    async function requestReset(email: string): Promise<string> {
      const before = sent.length;
      const c = await new Client().init();
      expect((await c.req('POST', '/api/auth/forgot', { email })).statusCode).toBe(204);
      await new Promise((r) => setImmediate(r));
      expect(sent.length).toBe(before + 1);
      const link = new URL(sent.at(-1)!.link);
      expect(link.origin + link.pathname).toBe('https://app.test/reset');
      return link.searchParams.get('token')!;
    }

    it('resets the password once, logs out every device, and stores only the hash', async () => {
      const { email, password, id } = await registered();
      const device = new Client();
      await device.login(email, password);

      const token = await requestReset(email);
      const { rows } = await pool.query<{ token_hash: string; ttl: number }>(
        `select token_hash, round(extract(epoch from expires_at - now()))::int as ttl
           from password_resets where user_id = $1`,
        [id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.token_hash).toBe(sha256Hex(token));
      expect(rows[0]!.ttl).toBeGreaterThan(29 * 60);
      expect(rows[0]!.ttl).toBeLessThanOrEqual(30 * 60);

      const c = await new Client().init();
      expect((await c.req('POST', '/api/auth/reset', { token, password: 'senha-nova-456' })).statusCode).toBe(204);

      expect((await device.req('GET', '/api/me')).statusCode).toBe(401);
      expect((await new Client().login(email, password)).statusCode).toBe(401);
      expect((await new Client().login(email, 'senha-nova-456')).statusCode).toBe(200);

      const reuse = await c.req('POST', '/api/auth/reset', { token, password: 'outra-senha-789' });
      expect(reuse.statusCode).toBe(400);
      expect(reuse.json()).toMatchObject({ error: { code: 'invalid_token' } });
    });

    it('using one link invalidates the other outstanding links', async () => {
      const { email } = await registered();
      const first = await requestReset(email);
      const second = await requestReset(email);
      const c = await new Client().init();
      expect((await c.req('POST', '/api/auth/reset', { token: second, password: 'senha-nova-456' })).statusCode).toBe(204);
      expect((await c.req('POST', '/api/auth/reset', { token: first, password: 'senha-nova-789' })).statusCode).toBe(400);
    });

    it('rejects an expired link', async () => {
      const { email, id } = await registered();
      const token = await requestReset(email);
      await pool.query(`update password_resets set expires_at = now() - interval '1 second' where user_id = $1`, [id]);
      const c = await new Client().init();
      const res = await c.req('POST', '/api/auth/reset', { token, password: 'senha-nova-456' });
      expect(res.statusCode).toBe(400);
    });

    it('does not mail unknown or blocked accounts', async () => {
      const { email, id } = await registered();
      await pool.query(`update users set status = 'blocked' where id = $1`, [id]);
      const before = sent.length;
      const c = await new Client().init();
      expect((await c.req('POST', '/api/auth/forgot', { email })).statusCode).toBe(204);
      expect((await c.req('POST', '/api/auth/forgot', { email: newEmail() })).statusCode).toBe(204);
      await new Promise((r) => setImmediate(r));
      expect(sent.length).toBe(before);
    });
  });

  it('login rate limit is stored in Redis', async () => {
    const c = new Client();
    for (let i = 0; i < 10; i++) expect((await c.login(newEmail(), 'x')).statusCode).toBe(401);
    expect((await c.login(newEmail(), 'x')).statusCode).toBe(429);
    const keys = await redis.keys(`${RL_NS}*${c.ip}*`);
    expect(keys.length).toBeGreaterThan(0);
  });
});
