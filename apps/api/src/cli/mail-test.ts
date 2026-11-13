/**
 * Sends a sample password-reset e-mail through the SMTP mailbox (Hostinger), to see how it looks.
 * The link inside is a dummy: it opens the reset page but no token is valid.
 * The password comes from SMTP_PASS or is asked here (not echoed), so it never lands in shell history.
 *
 *   npm run mail:test -w @traderoom/api -- voce@exemplo.com
 */
import { createInterface } from 'node:readline';
import Fastify from 'fastify';
import { z } from 'zod';
import { createSmtpMailer, mailAddress } from '../lib/mailer.js';

function askHidden(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let asked = false;
  // Echo the question once, then nothing the user types.
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
    if (!asked) {
      asked = true;
      process.stdout.write(s);
    }
  };
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    }),
  );
}

async function main(): Promise<void> {
  const to = z.email().parse(process.argv[2]);
  const from = process.env['MAIL_FROM']?.trim() || 'Kyden <support@kydeninvest.com>';
  const user = process.env['SMTP_USER']?.trim() || mailAddress(from);
  const host = process.env['SMTP_HOST']?.trim() || 'smtp.hostinger.com';
  const port = Number(process.env['SMTP_PORT'] || 465);
  const origin = 'https://kydeninvest.com';
  const pass = process.env['SMTP_PASS']?.trim() || (await askHidden(`Senha da caixa ${user}: `));
  if (!pass) throw new Error('sem senha');

  const log = Fastify({ logger: { level: 'info', transport: undefined } }).log;
  const mailer = createSmtpMailer(log, { host, port, user, pass, from });
  await mailer.sendPasswordReset(to, `${origin}/reset?token=EXEMPLO-link-de-teste`);
  console.log(`Enviado de ${from} para ${to} via ${host}:${port}.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
