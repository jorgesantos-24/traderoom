import type { FastifyBaseLogger } from 'fastify';
import nodemailer from 'nodemailer';

export interface Mailer {
  sendPasswordReset(to: string, link: string): Promise<void>;
}

/** Dev only: prints the reset link to the log instead of sending e-mail. */
export function createConsoleMailer(log: FastifyBaseLogger): Mailer {
  return {
    async sendPasswordReset(to, link) {
      log.info({ to, resetLink: link }, 'password reset link (dev mailer)');
    },
  };
}

/** Used when no transport is configured outside dev: never logs the link, only that it was dropped. */
export function createNullMailer(log: FastifyBaseLogger): Mailer {
  return {
    async sendPasswordReset() {
      log.warn('password reset requested but no mail transport is configured');
    },
  };
}

/** `Kyden <a@b.com>` → `a@b.com`; a bare address is returned trimmed. */
export function mailAddress(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m?.[1] ?? from).trim();
}

export interface SmtpOptions {
  /** e.g. smtp.hostinger.com */
  host: string;
  /** 465 = implicit TLS (Hostinger's default); 587 = STARTTLS. */
  port: number;
  user: string;
  pass: string;
  /** e.g. `Kyden <nao-responda@kydeninvest.com>`; the address must be the SMTP account (or an alias of it). */
  from: string;
  timeoutMs?: number;
  /** Tests inject a fake; production builds a nodemailer transport. */
  transport?: { sendMail(mail: { from: string; to: string; subject: string; text: string; html: string }): Promise<unknown> };
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Sends through an SMTP mailbox (Hostinger Email). One retry on any failure (auth errors
 * included: cheap, and SMTP gives no reliable retryable flag). Logs never carry the link.
 */
export function createSmtpMailer(log: FastifyBaseLogger, o: SmtpOptions): Mailer {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const transport =
    o.transport ??
    nodemailer.createTransport({
      host: o.host,
      port: o.port,
      secure: o.port === 465,
      requireTLS: o.port !== 465,
      auth: { user: o.user, pass: o.pass },
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
    });

  return {
    async sendPasswordReset(to, link) {
      const mail = passwordResetEmail(link);
      const msg = { from: o.from, to, subject: mail.subject, text: mail.text, html: mail.html };
      let lastErr: unknown;
      for (let i = 0; i < 2; i++) {
        if (i > 0) await sleep(1000);
        try {
          await transport.sendMail(msg);
          log.info('password reset e-mail sent');
          return;
        } catch (err) {
          lastErr = err;
        }
      }
      const code = (lastErr as { code?: string; responseCode?: number } | undefined) ?? {};
      log.error({ code: code.code, responseCode: code.responseCode }, 'password reset e-mail was not accepted by SMTP');
      throw new Error(`SMTP refused the e-mail (${code.responseCode ?? code.code ?? 'unknown error'})`);
    },
  };
}

export interface ResendOptions {
  apiKey: string;
  /** e.g. `Traderoom <nao-responda@seu-dominio.com>`; the domain must be verified in Resend. */
  from: string;
  endpoint?: string;
  timeoutMs?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

export function passwordResetEmail(link: string): { subject: string; text: string; html: string } {
  const subject = 'Redefinição de senha — Kyden';
  const text = [
    'Recebemos um pedido para redefinir a senha da sua conta Kyden.',
    '',
    `Abra este link para criar uma nova senha (válido por 30 minutos, uso único):`,
    link,
    '',
    'Se não foi você, ignore este e-mail: sua senha continua a mesma.',
  ].join('\n');
  const safe = escapeHtml(link);
  const html = `<!doctype html><html lang="pt-BR"><body style="font-family:Inter,Arial,sans-serif;color:#0C141A">
<p>Recebemos um pedido para redefinir a senha da sua conta Kyden.</p>
<p><a href="${safe}">Criar uma nova senha</a> (válido por 30 minutos, uso único).</p>
<p style="color:#555">Se o botão não abrir, copie este endereço: ${safe}</p>
<p style="color:#555">Se não foi você, ignore este e-mail: sua senha continua a mesma.</p>
</body></html>`;
  return { subject, text, html };
}

/**
 * Sends through Resend's HTTP API with plain fetch (no SDK). One retry on 429/5xx/network
 * errors. Logs carry the status only: never the link, which is a live credential.
 */
export function createResendMailer(log: FastifyBaseLogger, o: ResendOptions): Mailer {
  const endpoint = o.endpoint ?? 'https://api.resend.com/emails';
  const timeoutMs = o.timeoutMs ?? 10_000;
  const doFetch = o.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function attempt(body: string): Promise<{ ok: boolean; retry: boolean; status: number | null }> {
    try {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.body?.cancel().catch(() => {});
      return { ok: res.ok, retry: res.status === 429 || res.status >= 500, status: res.status };
    } catch {
      return { ok: false, retry: true, status: null };
    }
  }

  return {
    async sendPasswordReset(to, link) {
      const mail = passwordResetEmail(link);
      const body = JSON.stringify({ from: o.from, to: [to], subject: mail.subject, text: mail.text, html: mail.html });
      let r = await attempt(body);
      if (!r.ok && r.retry) {
        await sleep(1000);
        r = await attempt(body);
      }
      if (!r.ok) {
        log.error({ status: r.status }, 'password reset e-mail was not accepted by Resend');
        throw new Error(`Resend refused the e-mail (status ${r.status ?? 'network error'})`);
      }
      log.info('password reset e-mail sent');
    },
  };
}
