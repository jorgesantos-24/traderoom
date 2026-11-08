// Requires `npm run dev:deps` and `npm run db:migrate` first.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { encodeSessionCookie } from '@traderoom/shared';
import { loadConfig } from '../src/config.js';
import { createSessionStore } from '../src/gateway/session.js';
import { createPool } from '../src/lib/db.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
let pool: pg.Pool;
const userIds: string[] = [];

async function makeSession(
  opts: { expired?: boolean; blocked?: boolean } = {},
): Promise<{ cookie: string; sessionId: string; userId: string }> {
  const email = `ws-int-${randomUUID()}@example.test`;
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (email, password_hash, name, status) values ($1, '!', 'WS Test', $2) returning id`,
    [email, opts.blocked ? 'blocked' : 'active'],
  );
  const userId = rows[0]?.id ?? '';
  userIds.push(userId);
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  const s = await pool.query<{ id: string }>(
    `insert into sessions (user_id, token_hash, expires_at)
     values ($1, $2, now() + ($3 || ' seconds')::interval) returning id`,
    [userId, hash, opts.expired ? '-1' : '3600'],
  );
  const sessionId = s.rows[0]?.id ?? '';
  return { cookie: `other=1; sid=${encodeURIComponent(encodeSessionCookie(sessionId, token))}`, sessionId, userId };
}

beforeAll(() => {
  pool = createPool(config.DATABASE_URL, 2);
});

afterAll(async () => {
  await pool.query('delete from users where id = any($1::uuid[])', [userIds]);
  await pool.end();
});

describe('SessionStore against Postgres', () => {
  it('resolves a valid session cookie to its user', async () => {
    const s = await makeSession();
    expect(await createSessionStore(pool).resolve(s.cookie)).toEqual({ sessionId: s.sessionId, userId: s.userId });
  });

  it('rejects expired sessions, blocked users and forged tokens', async () => {
    const store = createSessionStore(pool);
    expect(await store.resolve((await makeSession({ expired: true })).cookie)).toBeNull();
    expect(await store.resolve((await makeSession({ blocked: true })).cookie)).toBeNull();
    const s = await makeSession();
    const forged = s.cookie.replace(/\.[A-Za-z0-9_-]{43}$/, `.${'A'.repeat(43)}`);
    expect(await store.resolve(forged)).toBeNull();
    expect(await store.resolve(undefined)).toBeNull();
    expect(await store.resolve('sid=garbage')).toBeNull();
  });

  it('stillValid drops logged-out sessions and blocked users', async () => {
    const store = createSessionStore(pool);
    const a = await makeSession();
    const b = await makeSession();
    const c = await makeSession();
    await pool.query('delete from sessions where id = $1', [b.sessionId]);
    await pool.query(`update users set status = 'blocked' where id = $1`, [c.userId]);
    expect(await store.stillValid([a.sessionId, b.sessionId, c.sessionId])).toEqual(new Set([a.sessionId]));
    expect(await store.stillValid([])).toEqual(new Set());
  });
});
