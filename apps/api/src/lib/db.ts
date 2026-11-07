import pg from 'pg';
import type { Config } from '../config.js';

export function createPool(config: Pick<Config, 'DATABASE_URL' | 'DATABASE_POOL_MAX'>): pg.Pool {
  return new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

/** Runs `fn` inside BEGIN/COMMIT on one pooled client; rolls back on any throw. */
export async function inTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
