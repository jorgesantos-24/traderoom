import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { authOf } from '../src/plugins/security.js';
import { AppError } from '../src/lib/errors.js';
import { captureMailer, FAKE_ADMIN_SID, FAKE_SID, fakeAuth, TEST_USER, testApp, type TestAppOptions } from './helpers.js';

const CSRF = 'c'.repeat(43);
const csrfHeaders = { cookie: `__Host-csrf=${CSRF}`, 'x-csrf-token': CSRF };
const VALID_REGISTER = { email: 'ana@example.com', password: 'senha-forte-123', name: 'Ana' };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(o: TestAppOptions = {}): Promise<FastifyInstance> {
  app = await testApp(o);
  return app;
}

function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const v = res.headers['set-cookie'];
  return Array.isArray(v) ? (v as string[]) : typeof v === 'string' ? [v] : [];
}

describe('CSRF double-submit', () => {
  it('GET /api/auth/csrf issues a __Host- cookie and returns the same token', async () => {
    const a = await start();
    const res = await a.inject({ method: 'GET', url: '/api/auth/csrf' });
    expect(res.statusCode).toBe(200);
    const { csrfToken } = res.json<{ csrfToken: string }>();
    expect(csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = setCookies(res).find((c) => c.startsWith('__Host-csrf='));
    expect(cookie).toBeDefined();
    expect(cookie).toContain(`__Host-csrf=${csrfToken}`);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).not.toMatch(/HttpOnly/);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it('reuses an existing CSRF cookie instead of rotating it', async () => {
    const a = await start();
    const res = await a.inject({ method: 'GET', url: '/api/auth/csrf', headers: { cookie: `__Host-csrf=${CSRF}` } });
    expect(res.json()).toEqual({ csrfToken: CSRF });
    expect(setCookies(res)).toHaveLength(0);
  });

  it.each([
    ['no cookie and no header', {}],
    ['header only', { 'x-csrf-token': CSRF }],
    ['cookie only', { cookie: `__Host-csrf=${CSRF}` }],
    ['mismatch', { cookie: `__Host-csrf=${CSRF}`, 'x-csrf-token': 'd'.repeat(43) }],
    ['wrong cookie name', { cookie: `csrf=${CSRF}`, 'x-csrf-token': CSRF }],
  ])('rejects POST with %s', async (_label, headers) => {
    const a = await start();
    const res = await a.inject({ method: 'POST', url: '/api/auth/register', headers, payload: VALID_REGISTER });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'csrf_failed' } });
  });

  it('applies to logout, forgot and reset too', async () => {
    const a = await start();
    for (const url of ['/api/auth/logout', '/api/auth/forgot', '/api/auth/reset']) {
      const res = await a.inject({ method: 'POST', url, payload: {} });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it('applies to PATCH as well as POST', async () => {
    const a = await start({ extend: (x) => x.patch('/t/patch', async () => ({ ok: true })) });
    expect((await a.inject({ method: 'PATCH', url: '/t/patch' })).statusCode).toBe(403);
    expect((await a.inject({ method: 'PATCH', url: '/t/patch', headers: csrfHeaders })).statusCode).toBe(200);
  });

  it('exempts login', async () => {
    const a = await start();
    const res = await a.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ana@example.com', password: 'whatever' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('register', () => {
  it('returns 201 with the public user', async () => {
    const a = await start();
    const res = await a.inject({ method: 'POST', url: '/api/auth/register', headers: csrfHeaders, payload: VALID_REGISTER });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ user: { ...TEST_USER, email: 'ana@example.com', name: 'Ana' } });
  });

  it.each([
    ['empty password', { ...VALID_REGISTER, password: '' }, 'password'],
    ['password over 128 chars', { ...VALID_REGISTER, password: 'x'.repeat(129) }, 'password'],
    ['invalid e-mail', { ...VALID_REGISTER, email: 'not-an-email' }, 'email'],
    ['blank name', { ...VALID_REGISTER, name: '   ' }, 'name'],
    ['missing field', { email: 'ana@example.com', password: 'senha-forte-123' }, 'name'],
  ])('rejects %s with 400', async (_label, payload, field) => {
    const a = await start();
    const res = await a.inject({ method: 'POST', url: '/api/auth/register', headers: csrfHeaders, payload });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.message.startsWith(`${field}: `)).toBe(true);
  });

  it('accepts a 1-character password and trims e-mail and name', async () => {
    let seen: unknown;
    const a = await start({
      deps: {
        auth: fakeAuth({
          register: async (input) => {
            seen = input;
            return TEST_USER;
          },
        }),
      },
    });
    const res = await a.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: csrfHeaders,
      payload: { email: '  ana@example.com ', password: '1', name: ' Ana ' },
    });
    expect(res.statusCode).toBe(201);
    expect(seen).toEqual({ email: 'ana@example.com', password: '1', name: 'Ana' });
  });
});

describe('login', () => {
  it('sets an httpOnly, Secure, SameSite=Lax session cookie valid for 7 days, plus a fresh CSRF token', async () => {
    const a = await start();
    const res = await a.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ana@example.com', password: 'whatever' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<{ user: unknown; csrfToken: string }>();
    expect(body.user).toEqual(TEST_USER);

    const cookies = setCookies(res);
    const sid = cookies.find((c) => c.startsWith('sid='));
    expect(sid).toBeDefined();
    expect(sid).toContain(`sid=${encodeURIComponent(FAKE_SID)}`);
    expect(sid).toMatch(/; Max-Age=604800/);
    expect(sid).toMatch(/; Path=\//);
    expect(sid).toMatch(/; HttpOnly/);
    expect(sid).toMatch(/; Secure/);
    expect(sid).toMatch(/; SameSite=Lax/);

    const csrf = cookies.find((c) => c.startsWith('__Host-csrf='));
    expect(csrf).toContain(`__Host-csrf=${body.csrfToken}`);
  });

  it('passes service errors through in the standard format', async () => {
    const a = await start({
      deps: {
        auth: fakeAuth({
          login: async () => {
            throw new AppError(401, 'invalid_credentials', 'E-mail ou senha incorretos.');
          },
        }),
      },
    });
    const res = await a.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@b.co', password: 'x' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'invalid_credentials', message: 'E-mail ou senha incorretos.' } });
    expect(setCookies(res).some((c) => c.startsWith('sid='))).toBe(false);
  });
});

describe('logout', () => {
  it('clears the session cookie and returns 204', async () => {
    let loggedOut: string | undefined;
    const a = await start({ deps: { auth: fakeAuth({ logout: async (v) => void (loggedOut = v) }) } });
    const res = await a.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...csrfHeaders, cookie: `${csrfHeaders.cookie}; sid=${encodeURIComponent(FAKE_SID)}` },
    });
    expect(res.statusCode).toBe(204);
    expect(loggedOut).toBe(FAKE_SID);
    const sid = setCookies(res).find((c) => c.startsWith('sid='));
    expect(sid).toMatch(/^sid=;/);
    expect(sid).toMatch(/Expires=Thu, 01 Jan 1970/);
  });
});

describe('forgot / reset', () => {
  it('always returns 204 and only mails when the account exists', async () => {
    const { mailer, sent } = captureMailer();
    const a = await start({
      mailer,
      deps: {
        auth: fakeAuth({
          requestPasswordReset: async (email) => (email === 'ana@example.com' ? { email, token: 'T'.repeat(43) } : null),
        }),
      },
    });
    const known = await a.inject({
      method: 'POST',
      url: '/api/auth/forgot',
      headers: csrfHeaders,
      payload: { email: 'ana@example.com' },
    });
    const unknown = await a.inject({
      method: 'POST',
      url: '/api/auth/forgot',
      headers: csrfHeaders,
      payload: { email: 'nobody@example.com' },
    });
    expect(known.statusCode).toBe(204);
    expect(unknown.statusCode).toBe(204);
    expect(known.body).toBe(unknown.body);
    await new Promise((r) => setImmediate(r));
    expect(sent).toEqual([{ to: 'ana@example.com', link: `https://app.test/reset?token=${'T'.repeat(43)}` }]);
  });

  it('still returns 204 when the mailer fails', async () => {
    const a = await start({
      mailer: { sendPasswordReset: async () => Promise.reject(new Error('smtp down')) },
      deps: { auth: fakeAuth({ requestPasswordReset: async (email) => ({ email, token: 'T'.repeat(43) }) }) },
    });
    const res = await a.inject({
      method: 'POST',
      url: '/api/auth/forgot',
      headers: csrfHeaders,
      payload: { email: 'ana@example.com' },
    });
    expect(res.statusCode).toBe(204);
  });

  it('rejects a malformed reset token before touching the service', async () => {
    let called = false;
    const a = await start({ deps: { auth: fakeAuth({ resetPassword: async () => void (called = true) }) } });
    const res = await a.inject({
      method: 'POST',
      url: '/api/auth/reset',
      headers: csrfHeaders,
      payload: { token: 'short', password: 'nova-senha-123' },
    });
    expect(res.statusCode).toBe(400);
    expect(called).toBe(false);
  });
});

describe('requireAuth / requireAdmin', () => {
  const guarded = (x: FastifyInstance): void => {
    x.get('/t/admin', { preHandler: x.requireAdmin }, async (req) => ({ id: authOf(req).user.id }));
  };

  it('GET /api/me is 401 without a valid session', async () => {
    const a = await start();
    for (const cookie of [undefined, 'sid=garbage', `sid=${encodeURIComponent(FAKE_SID)}x`]) {
      const opts: InjectOptions = { method: 'GET', url: '/api/me', ...(cookie ? { headers: { cookie } } : {}) };
      const res = await a.inject(opts);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'unauthorized' } });
    }
  });

  it('GET /api/me returns the session user', async () => {
    const a = await start();
    const res = await a.inject({ method: 'GET', url: '/api/me', headers: { cookie: `sid=${encodeURIComponent(FAKE_SID)}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: TEST_USER });
  });

  it('requireAdmin: 401 anonymous, 403 user, 200 admin', async () => {
    const a = await start({ extend: guarded });
    expect((await a.inject({ method: 'GET', url: '/t/admin' })).statusCode).toBe(401);
    const asUser = await a.inject({ method: 'GET', url: '/t/admin', headers: { cookie: `sid=${encodeURIComponent(FAKE_SID)}` } });
    expect(asUser.statusCode).toBe(403);
    expect(asUser.json()).toMatchObject({ error: { code: 'forbidden' } });
    const asAdmin = await a.inject({
      method: 'GET',
      url: '/t/admin',
      headers: { cookie: `sid=${encodeURIComponent(FAKE_ADMIN_SID)}` },
    });
    expect(asAdmin.statusCode).toBe(200);
  });
});

describe('rate limits', () => {
  const login = (a: FastifyInstance, ip: string) =>
    a.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: ip,
      payload: { email: 'ana@example.com', password: 'whatever' },
    });

  it.skip('allows 10 logins per IP per 5 minutes, then 429 in the standard format', async () => {
    const a = await start();
    for (let i = 0; i < 10; i++) expect((await login(a, '10.0.0.1')).statusCode).toBe(200);
    const blocked = await login(a, '10.0.0.1');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({
      error: { code: 'rate_limited', message: 'Muitas requisições. Tente novamente em instantes.' },
    });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(200);
    // Another IP is unaffected.
    expect((await login(a, '10.0.0.2')).statusCode).toBe(200);
  });

  it.skip('allows 5 registrations per IP per hour', async () => {
    const a = await start();
    const register = () =>
      a.inject({
        method: 'POST',
        url: '/api/auth/register',
        remoteAddress: '10.0.0.3',
        headers: csrfHeaders,
        payload: VALID_REGISTER,
      });
    for (let i = 0; i < 5; i++) expect((await register()).statusCode).toBe(201);
    const blocked = await register();
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(3000);
  });

  it.skip('applies the global per-IP limit to other routes', async () => {
    const a = await start({ globalMax: 3 });
    const me = () => a.inject({ method: 'GET', url: '/api/me', remoteAddress: '10.0.0.4' });
    for (let i = 0; i < 3; i++) expect((await me()).statusCode).toBe(401);
    expect((await me()).statusCode).toBe(429);
  });

  it('never rate-limits the health check', async () => {
    const a = await start({ globalMax: 2 });
    for (let i = 0; i < 5; i++) {
      expect((await a.inject({ method: 'GET', url: '/api/health', remoteAddress: '10.0.0.5' })).statusCode).toBe(200);
    }
  });

  it.skip('uses X-Forwarded-For only when the request comes from the local proxy', async () => {
    const a = await start({ globalMax: 1 });
    const viaProxy = (xff: string) =>
      a.inject({ method: 'GET', url: '/api/me', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': xff } });
    expect((await viaProxy('203.0.113.1')).statusCode).toBe(401);
    expect((await viaProxy('203.0.113.2')).statusCode).toBe(401);
    expect((await viaProxy('203.0.113.1')).statusCode).toBe(429);

    // A remote client cannot dodge the limit by spoofing the header.
    const spoof = (xff: string) =>
      a.inject({ method: 'GET', url: '/api/me', remoteAddress: '198.51.100.9', headers: { 'x-forwarded-for': xff } });
    expect((await spoof('1.1.1.1')).statusCode).toBe(401);
    expect((await spoof('2.2.2.2')).statusCode).toBe(429);
  });
});
