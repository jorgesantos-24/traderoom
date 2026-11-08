import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createResendMailer, passwordResetEmail } from '../src/lib/mailer.js';

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
