/**
 * Sets a client's password (support: client who cannot log in). The new password is read from
 * stdin so it never shows up in shell history or the process list. Like a reset by e-mail link,
 * it also logs out every device and invalidates pending reset links.
 *
 *   echo -n 'nova-senha' | npm run set-password -w @traderoom/api -- ana@example.com
 *   build de produção: echo -n 'nova-senha' | node --env-file=.env apps/api/dist/cli/set-password.js ana@example.com
 */
import { text } from 'node:stream/consumers';
import { PASSWORD_MAX_LENGTH } from '@traderoom/shared';
import pg from 'pg';
import { z } from 'zod';
import { hashPassword } from '../lib/password.js';

const Args = z.tuple([z.string().trim().pipe(z.email('E-mail inválido.'))]);
const Password = z
  .string()
  .min(1, 'Senha vazia (envie a senha pelo stdin).')
  .max(PASSWORD_MAX_LENGTH, `A senha pode ter no máximo ${PASSWORD_MAX_LENGTH} caracteres.`);

async function main(): Promise<void> {
  const databaseUrl = z.url().parse(process.env['DATABASE_URL']);
  const [email] = Args.parse(process.argv.slice(2));
  // Only the trailing newline added by echo/pipes is dropped; the password is otherwise taken verbatim.
  const password = Password.parse((await text(process.stdin)).replace(/\r?\n$/, ''));
  const passwordHash = await hashPassword(password);

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query<{ id: string; email: string; status: string }>(
      'update users set password_hash = $2 where email = $1 returning id, email::text as email, status',
      [email, passwordHash],
    );
    const user = rows[0];
    if (!user) {
      await client.query('rollback');
      console.error(`No user with e-mail ${email}.`);
      process.exitCode = 1;
      return;
    }
    await client.query('update password_resets set used = true where user_id = $1 and not used', [user.id]);
    await client.query('delete from sessions where user_id = $1', [user.id]);
    await client.query('commit');
    console.log(`Password updated for ${user.email}.`);
    if (user.status !== 'active') console.log(`Note: account status is "${user.status}", which may still block login.`);
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof z.ZodError ? z.prettifyError(err) : err);
  process.exitCode = 1;
});
