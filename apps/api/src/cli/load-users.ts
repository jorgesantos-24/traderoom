/**
 * Dev/staging only: creates throwaway users with ready sessions for load tests,
 * or deletes them. Users get an unusable password hash, so nobody can log in as them.
 *
 *   npm run load-users -w @traderoom/api -- create 500 ../../tests/k6/.sessions.json
 *   npm run load-users -w @traderoom/api -- delete
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { encodeSessionCookie } from '@traderoom/shared';
import { generateToken, sha256Hex } from '../lib/tokens.js';

const EMAIL_DOMAIN = 'load.test';
const SESSION_HOURS = 24;

const Args = z.union([
  z.tuple([z.literal('create'), z.coerce.number().int().min(1).max(5000), z.string().min(1)]),
  z.tuple([z.literal('delete')]),
]);

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') throw new Error('load-users refuses to run with NODE_ENV=production');
  const databaseUrl = z.url().parse(process.env['DATABASE_URL']);
  const args = Args.parse(process.argv.slice(2));
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    // Cascades to sessions and accounts. Load users never place orders, so nothing else references them.
    const del = await pool.query(`delete from users where email like $1`, [`%@${EMAIL_DOMAIN}`]);
    if (args[0] === 'delete') {
      console.log(`Deleted ${del.rowCount ?? 0} load-test user(s).`);
      return;
    }

    const [, count, outFile] = args;
    const out: Array<{ email: string; sid: string }> = [];
    const client = await pool.connect();
    try {
      await client.query('begin');
      for (let i = 1; i <= count; i++) {
        const email = `load-${String(i).padStart(4, '0')}@${EMAIL_DOMAIN}`;
        const u = await client.query<{ id: string }>(
          `insert into users (email, password_hash, name) values ($1, '!', $2) returning id`,
          [email, `Carga ${i}`],
        );
        const userId = u.rows[0]?.id;
        if (!userId) throw new Error('insert returned no id');
        await client.query(`insert into accounts (user_id, kind) values ($1, 'real'), ($1, 'demo')`, [userId]);
        const token = generateToken();
        const s = await client.query<{ id: string }>(
          `insert into sessions (user_id, token_hash, expires_at)
           values ($1, $2, now() + make_interval(hours => $3)) returning id`,
          [userId, sha256Hex(token), SESSION_HOURS],
        );
        out.push({ email, sid: encodeSessionCookie(s.rows[0]?.id ?? '', token) });
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    const path = resolve(outFile);
    writeFileSync(path, JSON.stringify(out), { mode: 0o600 });
    console.log(`Created ${count} load-test user(s) with ${SESSION_HOURS} h sessions → ${path}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
