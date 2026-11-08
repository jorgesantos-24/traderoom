/**
 * Grants or removes the admin role. This is the only way to create the first admin:
 * there is deliberately no HTTP endpoint that changes roles. Run it on the server.
 *
 *   npm run admin-role -w @traderoom/api -- promote ana@example.com
 *   npm run admin-role -w @traderoom/api -- demote ana@example.com
 *   npm run admin-role -w @traderoom/api -- list
 */
import pg from 'pg';
import { z } from 'zod';

const Args = z.union([z.tuple([z.enum(['promote', 'demote']), z.email('E-mail inválido.')]), z.tuple([z.literal('list')])]);

async function main(): Promise<void> {
  const databaseUrl = z.url().parse(process.env['DATABASE_URL']);
  const args = Args.parse(process.argv.slice(2));
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    if (args[0] === 'list') {
      const { rows } = await pool.query<{ email: string; status: string }>(
        `select email::text as email, status from users where role = 'admin' order by created_at`,
      );
      if (rows.length === 0) console.log('No admins.');
      for (const r of rows) console.log(`${r.email}${r.status === 'blocked' ? ' (blocked)' : ''}`);
      return;
    }
    const [action, email] = args;
    const role = action === 'promote' ? 'admin' : 'user';
    // Roles are read on every request, so the change applies to open sessions immediately.
    const { rowCount } = await pool.query('update users set role = $2 where email = $1', [email, role]);
    if (!rowCount) {
      console.error(`No user with e-mail ${email}.`);
      process.exitCode = 1;
      return;
    }
    console.log(`${email} is now ${role}.`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof z.ZodError ? z.prettifyError(err) : err);
  process.exitCode = 1;
});
