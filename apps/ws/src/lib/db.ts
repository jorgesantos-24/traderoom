import pg from 'pg';

export function createPool(databaseUrl: string, max: number): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}
