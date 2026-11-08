import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FAKE_SID, testApp } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('security headers', () => {
  it('sets helmet headers on API responses, including errors', async () => {
    app = await testApp();
    for (const url of ['/api/health', '/api/nope', '/api/me']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-powered-by']).toBeUndefined();
    }
  });
});

describe('CORS', () => {
  it('answers preflight only for the public origin', async () => {
    app = await testApp();
    const ok = await app.inject({
      method: 'OPTIONS',
      url: '/api/orders',
      headers: {
        origin: 'https://app.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-csrf-token,idempotency-key',
      },
    });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.test');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');

    const evil = await app.inject({
      method: 'OPTIONS',
      url: '/api/orders',
      headers: { origin: 'https://evil.test', 'access-control-request-method': 'POST' },
    });
    expect(evil.headers['access-control-allow-origin']).not.toBe('https://evil.test');
    const get = await app.inject({ method: 'GET', url: '/api/me', headers: { origin: 'https://evil.test', cookie: `sid=${FAKE_SID}` } });
    expect(get.headers['access-control-allow-origin']).not.toBe('https://evil.test');
  });
});

describe('body limit', () => {
  it('refuses bodies over 16 KB with the standard error shape', async () => {
    app = await testApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(17 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: { code: 'payload_too_large' } });
  });
});
