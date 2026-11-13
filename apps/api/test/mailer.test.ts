import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createResendMailer, createSmtpMailer, mailAddress, passwordResetEmail } from '../src/lib/mailer.js';

const LINK = 'https://app.example.com/reset?token=abc_DEF-123';

function logSpy() {
  const lines: Array<{ level: string; obj: unknown; msg?: string }> = [];
  const base = Fastify({ logger: false }).log;
  const log = Object.assign(Object.create(base) as typeof base, {
    info: (obj: unknown, msg?: string) => lines.push({ level: 'info', obj, msg }),
    error: (obj: unknown, msg?: string) => lines.push({ level: 'error', obj, msg }),
  });
  return { log, lines };
}

function fakeFetch(statuses: Array<number | 'throw'>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const s = statuses.shift() ?? 200;
    if (s === 'throw') throw new TypeError('fetch failed');
    return new Response('{}', { status: s });
  };
  return { fn, calls };
}

describe('passwordResetEmail', () => {
  it('builds pt-BR text and escaped HTML', () => {
    const m = passwordResetEmail('https://x.test/reset?token=a&b="c"');
    expect(m.subject).toContain('Redefinição de senha');
    expect(m.text).toContain('https://x.test/reset?token=a&b="c"');
    expect(m.html).toContain('href="https://x.test/reset?token=a&amp;b=&quot;c&quot;"');
    expect(m.html).not.toContain('"c"');
  });
});

describe('createResendMailer', () => {
  it('posts to Resend with the key and never logs the link', async () => {
    const { log, lines } = logSpy();
    const f = fakeFetch([200]);
    const m = createResendMailer(log, { apiKey: 're_test', from: 'Traderoom <no@x.test>', fetch: f.fn, sleep: async () => {} });
    await m.sendPasswordReset('ana@x.test', LINK);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe('https://api.resend.com/emails');
    expect((f.calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer re_test');
    const body = JSON.parse(String(f.calls[0]?.init.body)) as { from: string; to: string[]; text: string };
    expect(body).toMatchObject({ from: 'Traderoom <no@x.test>', to: ['ana@x.test'] });
    expect(body.text).toContain(LINK);
    expect(JSON.stringify(lines)).not.toContain('abc_DEF');
  });

  it('retries once on 5xx, 429 or network error', async () => {
    for (const first of [503, 429, 'throw'] as const) {
      const { log } = logSpy();
      const f = fakeFetch([first, 200]);
      await createResendMailer(log, { apiKey: 'k', from: 'f@x.test', fetch: f.fn, sleep: async () => {} }).sendPasswordReset(
        'a@x.test',
        LINK,
      );
      expect(f.calls).toHaveLength(2);
    }
  });

  it('does not retry a 4xx and reports the failure without the link', async () => {
    const { log, lines } = logSpy();
    const f = fakeFetch([422]);
    const m = createResendMailer(log, { apiKey: 'k', from: 'f@x.test', fetch: f.fn, sleep: async () => {} });
    await expect(m.sendPasswordReset('a@x.test', LINK)).rejects.toThrow('status 422');
    expect(f.calls).toHaveLength(1);
    expect(lines).toEqual([{ level: 'error', obj: { status: 422 }, msg: 'password reset e-mail was not accepted by Resend' }]);
  });

  it('gives up after the retry fails too', async () => {
    const { log } = logSpy();
    const f = fakeFetch([500, 'throw']);
    const m = createResendMailer(log, { apiKey: 'k', from: 'f@x.test', fetch: f.fn, sleep: async () => {} });
    await expect(m.sendPasswordReset('a@x.test', LINK)).rejects.toThrow('network error');
    expect(f.calls).toHaveLength(2);
  });
});

describe('mailAddress', () => {
  it('extracts the address from a display name', () => {
    expect(mailAddress('Kyden <support@kydeninvest.com>')).toBe('support@kydeninvest.com');
    expect(mailAddress(' support@kydeninvest.com ')).toBe('support@kydeninvest.com');
  });
});

describe('createSmtpMailer', () => {
  const opts = { host: 'smtp.test', port: 465, user: 'u@x.test', pass: 'p', from: 'Kyden <u@x.test>', sleep: async () => {} };

  it('sends the reset mail through the transport', async () => {
    const sent: unknown[] = [];
    const { log, lines } = logSpy();
    const m = createSmtpMailer(log, { ...opts, transport: { sendMail: async (msg) => void sent.push(msg) } });
    await m.sendPasswordReset('a@b.test', LINK);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: 'Kyden <u@x.test>', to: 'a@b.test', subject: passwordResetEmail(LINK).subject });
    expect(JSON.stringify(lines)).not.toContain('token=');
  });

  it('retries once, then throws without logging the link', async () => {
    let calls = 0;
    const { log, lines } = logSpy();
    const m = createSmtpMailer(log, {
      ...opts,
      transport: {
        sendMail: async () => {
          calls++;
          throw Object.assign(new Error(`Invalid login ${LINK}`), { code: 'EAUTH', responseCode: 535 });
        },
      },
    });
    await expect(m.sendPasswordReset('a@b.test', LINK)).rejects.toThrow('535');
    expect(calls).toBe(2);
    expect(JSON.stringify(lines)).not.toContain('token=');
  });

  it('succeeds on the retry', async () => {
    let calls = 0;
    const { log } = logSpy();
    const m = createSmtpMailer(log, {
      ...opts,
      transport: { sendMail: async () => { if (++calls === 1) throw new Error('ETIMEDOUT'); } },
    });
    await m.sendPasswordReset('a@b.test', LINK);
    expect(calls).toBe(2);
  });
});
