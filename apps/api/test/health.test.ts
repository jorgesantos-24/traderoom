import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@traderoom/shared';
import { testApp } from './helpers.js';
import type { HealthDeps } from '../src/lib/health.js';

const NOW = 1_800_000_000_000;

function deps(overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    pingPostgres: async () => {},
    pingRedis: async () => {},
    getLastTickMs: async () => NOW - 100,
    now: () => NOW,
    feedMaxAgeMs: 5000,
    timeoutMs: 50,
    ...overrides,
  };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function getHealth(d: HealthDeps): Promise<{ status: number; body: HealthResponse; cache: unknown }> {
  app = await testApp({ deps: { health: d } });
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  return { status: res.statusCode, body: res.json<HealthResponse>(), cache: res.headers['cache-control'] };
}

describe('GET /api/health', () => {
  it('returns 200 when all dependencies are healthy', async () => {
    const r = await getHealth(deps());
    expect(r.status).toBe(200);
    expect(r.cache).toBe('no-store');
    expect(r.body.status).toBe('ok');
    expect(r.body.checks.postgres.ok).toBe(true);
    expect(r.body.checks.redis.ok).toBe(true);
    expect(r.body.checks.feed).toEqual({ ok: true, ageMs: 100 });
  });

  it('returns 503 when Postgres fails', async () => {
    const r = await getHealth(deps({ pingPostgres: async () => Promise.reject(new Error('connection refused')) }));
    expect(r.status).toBe(503);
    expect(r.body.status).toBe('fail');
    expect(r.body.checks.postgres).toMatchObject({ ok: false, error: 'connection refused' });
    expect(r.body.checks.redis.ok).toBe(true);
  });

  it('returns 503 when Redis hangs past the timeout', async () => {
    const r = await getHealth(deps({ pingRedis: () => new Promise(() => {}) }));
    expect(r.status).toBe(503);
    expect(r.body.checks.redis).toMatchObject({ ok: false, error: 'timeout after 50 ms' });
  });

  it('returns 503 when no tick was ever recorded', async () => {
    const r = await getHealth(deps({ getLastTickMs: async () => null }));
    expect(r.status).toBe(503);
    expect(r.body.checks.feed).toMatchObject({ ok: false, ageMs: null });
  });

  it('returns 503 when the feed is older than 5 s', async () => {
    const r = await getHealth(deps({ getLastTickMs: async () => NOW - 5001 }));
    expect(r.status).toBe(503);
    expect(r.body.checks.feed).toMatchObject({ ok: false, ageMs: 5001 });
  });

  it('accepts a feed exactly at the 5 s limit', async () => {
    const r = await getHealth(deps({ getLastTickMs: async () => NOW - 5000 }));
    expect(r.status).toBe(200);
    expect(r.body.checks.feed).toEqual({ ok: true, ageMs: 5000 });
  });

  it('treats a non-numeric stored tick as missing', async () => {
    const r = await getHealth(deps({ getLastTickMs: async () => Number('garbage') }));
    expect(r.status).toBe(503);
    expect(r.body.checks.feed.ageMs).toBeNull();
  });
});
