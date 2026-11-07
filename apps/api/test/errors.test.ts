import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiErrorBody } from '@traderoom/shared';
import { BODY_LIMIT_BYTES } from '../src/app.js';
import { AppError } from '../src/lib/errors.js';
import { testApp } from './helpers.js';

const CSRF = 'c'.repeat(43);
const csrf = { cookie: '__Host-csrf=' + CSRF, 'x-csrf-token': CSRF };

let app: FastifyInstance;

beforeAll(async () => {
  app = await testApp({
    extend: (a) => {
      a.post('/t/echo', async (req) => ({ ok: true, body: req.body }));
      a.get('/t/app-error', async () => {
        throw new AppError(409, 'conflict', 'Já existe.');
      });
      a.post('/t/zod', async (req) => z.object({ n: z.number() }).parse(req.body));
      a.get('/t/boom', async () => {
        throw new Error('secret internal detail');
      });
    },
  });
});

afterAll(async () => {
  await app.close();
});

function expectErrorShape(json: unknown): asserts json is ApiErrorBody {
  expect(json).toEqual({ error: { code: expect.any(String), message: expect.any(String) } });
}

describe('error format', () => {
  it('404 for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    const json = res.json();
    expectErrorShape(json);
    expect(json.error.code).toBe('not_found');
  });

  it('AppError keeps its status and code', async () => {
    const res = await app.inject({ method: 'GET', url: '/t/app-error' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'conflict', message: 'Já existe.' } });
  });

  it('zod errors become 400 validation_failed', async () => {
    const res = await app.inject({ method: 'POST', url: '/t/zod', headers: csrf, payload: { n: 'x' } });
    expect(res.statusCode).toBe(400);
    const json = res.json();
    expectErrorShape(json);
    expect(json.error.code).toBe('validation_failed');
    expect(json.error.message).toMatch(/^n: /);
  });

  it('unexpected errors become 500 without leaking details', async () => {
    const res = await app.inject({ method: 'GET', url: '/t/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'internal_error', message: 'Erro interno.' } });
    expect(res.body).not.toContain('secret');
  });

  it('invalid JSON becomes 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/t/echo',
      headers: { ...csrf, 'content-type': 'application/json' },
      payload: '{bad',
    });
    expect(res.statusCode).toBe(400);
    expectErrorShape(res.json());
  });

  it('accepts a body at the 16 KB limit and rejects one byte over', async () => {
    const overhead = JSON.stringify({ s: '' }).length;
    const atLimit = JSON.stringify({ s: 'a'.repeat(BODY_LIMIT_BYTES - overhead) });
    expect(atLimit.length).toBe(BODY_LIMIT_BYTES);
    const ok = await app.inject({
      method: 'POST',
      url: '/t/echo',
      headers: { ...csrf, 'content-type': 'application/json' },
      payload: atLimit,
    });
    expect(ok.statusCode).toBe(200);

    const over = JSON.stringify({ s: 'a'.repeat(BODY_LIMIT_BYTES - overhead + 1) });
    const res = await app.inject({
      method: 'POST',
      url: '/t/echo',
      headers: { ...csrf, 'content-type': 'application/json' },
      payload: over,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: { code: 'payload_too_large' } });
  });

  it('every response carries a request id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const notFound = await app.inject({ method: 'GET', url: '/nope' });
    expect(notFound.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
