// Requires `npm run dev:deps` and `npm run db:migrate` first.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import type { HealthResponse } from '@traderoom/shared';
import { RedisKeys } from '@traderoom/shared';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/lib/db.js';
import { createRedis } from '../src/lib/redis.js';
import { testApp } from './helpers.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
let pool: pg.Pool;
let redis: Redis;

beforeAll(() => {
  pool = createPool(config);
  redis = createRedis(config);
});

afterAll(async () => {
  await redis.del(RedisKeys.feedLastTickMs);
  await Promise.all([pool.end(), redis.quit()]);
});

describe('schema', () => {
  it('has every table from the spec', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name <> 'pgmigrations' order by 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'accounts',
      'admin_audit',
      'assets',
      'config',
      'deposits',
      'kyc_files',
      'kyc_submissions',
      'ledger',
      'orders',
      'password_resets',
      'price_snapshots',
      'sessions',
      'users',
      'withdrawals',
    ]);
  });

  it('seeds enabled assets with Binance aggTrade streams', async () => {
    const { rows } = await pool.query<{ symbol: string; binance_stream: string }>(
      'select symbol, binance_stream from assets where enabled order by sort',
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0]).toEqual({ symbol: 'BTCUSDT', binance_stream: 'btcusdt@aggTrade' });
  });

  it('rejects a negative balance and treats email case-insensitively', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query<{ id: string }>(
        `insert into users (email, password_hash, name) values ('Case@Test.dev', 'x', 'T') returning id`,
      );
      const id = rows[0]!.id;
      await client.query('insert into accounts (user_id) values ($1)', [id]);
      await client.query('savepoint s');
      await expect(client.query('update accounts set balance_cents = -1 where user_id = $1', [id])).rejects.toThrow(
        /balance_cents_check/,
      );
      await client.query('rollback to savepoint s');
      await expect(
        client.query(`insert into users (email, password_hash, name) values ('case@test.dev', 'x', 'T')`),
      ).rejects.toThrow(/users_email_key/);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});

describe('GET /api/health against real Postgres and Redis', () => {
  async function health(): Promise<{ status: number; body: HealthResponse }> {
    const app = await testApp({
      deps: {
        health: {
          pingPostgres: async () => {
            await pool.query('select 1');
          },
          pingRedis: async () => {
            await redis.ping();
          },
          getLastTickMs: async () => {
            const v = await redis.get(RedisKeys.feedLastTickMs);
            return v === null ? null : Number(v);
          },
          now: () => Date.now(),
          feedMaxAgeMs: config.HEALTH_FEED_MAX_AGE_MS,
          timeoutMs: 1000,
        },
      },
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      return { status: res.statusCode, body: res.json<HealthResponse>() };
    } finally {
      await app.close();
    }
  }

  it('is 503 with no feed, 200 with a fresh tick, 503 with an old tick', async () => {
    await redis.del(RedisKeys.feedLastTickMs);
    const none = await health();
    expect(none.status).toBe(503);
    expect(none.body.checks.postgres.ok).toBe(true);
    expect(none.body.checks.redis.ok).toBe(true);
    expect(none.body.checks.feed.ok).toBe(false);

    await redis.set(RedisKeys.feedLastTickMs, String(Date.now()));
    const fresh = await health();
    expect(fresh.status).toBe(200);
    expect(fresh.body.status).toBe('ok');

    await redis.set(RedisKeys.feedLastTickMs, String(Date.now() - 10_000));
    const old = await health();
    expect(old.status).toBe(503);
  });
});
