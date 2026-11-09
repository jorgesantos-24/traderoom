import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { chargeStatus, parseEagleCharge, parseEaglePayout, payoutStatus, verifyEagleSignature } from '../src/lib/eagle.js';
import { paymentSetup } from '../src/lib/payment-setup.js';

const SECRET = 'sk_test';
const sign = (ts: string, body: string) => 'sha256=' + createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');

describe('EaglePay', () => {
  it('checks the webhook signature over timestamp + raw body and refuses old calls', () => {
    const body = '{"transactionId":"t1","enStatusTransaction":"paid"}';
    const now = 1_762_700_000_000;
    const ts = String(now / 1000);
    expect(verifyEagleSignature(Buffer.from(body), ts, sign(ts, body), SECRET, now)).toBe(true);
    expect(verifyEagleSignature(Buffer.from(body + ' '), ts, sign(ts, body), SECRET, now)).toBe(false);
    expect(verifyEagleSignature(Buffer.from(body), ts, sign(ts, body), 'other', now)).toBe(false);
    expect(verifyEagleSignature(Buffer.from(body), ts, undefined, SECRET, now)).toBe(false);
    expect(verifyEagleSignature(Buffer.from(body), ts, sign(ts, body), SECRET, now + 600_000)).toBe(false);
  });

  it('maps its statuses and amounts', () => {
    expect(['processing', 'completed', 'rejected', 'refunded', 'chargeback'].map(chargeStatus)).toEqual([
      'pending',
      'paid',
      'failed',
      'refunded',
      'chargeback',
    ]);
    expect(['Awaiting', 'Processing', 'Successful', 'Failure', 'Rejected'].map(payoutStatus)).toEqual([
      'awaiting',
      'processing',
      'completed',
      'failed',
      'failed',
    ]);
    expect(parseEagleCharge({ id: 'a', amount: 1990, status: 'completed', metadata: 'dep-1' })).toEqual({
      providerId: 'a',
      externalId: 'dep-1',
      status: 'paid',
      amountCents: 1990,
    });
    expect(parseEaglePayout({ id: 512, amount: 150.1, status: 'Awaiting' })).toMatchObject({ providerId: '512', amountCents: 15010 });
  });

  it('picks EaglePay once its keys are set and keeps Novus for what it holds', () => {
    const base = { DATABASE_URL: 'postgres://x/y', REDIS_URL: 'redis://x', PUBLIC_ORIGIN: 'https://t.test' };
    const novusOnly = paymentSetup(loadConfig({ ...base, NOVUS_API_KEY: 'k', NOVUS_POSTBACKS: 'true' }));
    expect(novusOnly.gateway?.name).toBe('novus');
    expect(novusOnly.postbackUrl).toBe('https://t.test/api/webhooks/novus');

    const both = {
      ...base,
      NOVUS_API_KEY: 'k',
      EAGLE_CLIENT_ID: 'c',
      EAGLE_PUBLIC_KEY: 'p',
      EAGLE_SECRET_KEY: 's',
      PAYMENT_POSTBACKS: 'true',
    };
    const s = paymentSetup(loadConfig(both));
    expect(s.gateway?.name).toBe('eagle');
    expect(s.previousGateways.map((g) => g.name)).toEqual(['novus']);
    expect(s.postbackUrl).toBe('https://t.test/api/webhooks/eagle');
    expect(paymentSetup(loadConfig({ ...both, PAYMENT_PROVIDER: 'novus' })).gateway?.name).toBe('novus');

    expect(paymentSetup(loadConfig(base))).toEqual({ gateway: null, previousGateways: [], postbackUrl: null });
    expect(() => paymentSetup(loadConfig({ ...base, EAGLE_CLIENT_ID: 'c' }))).toThrow(/EAGLE_PUBLIC_KEY/);
    expect(() => paymentSetup(loadConfig({ ...base, PAYMENT_PROVIDER: 'eagle' }))).toThrow(/EAGLE_CLIENT_ID/);
  });
});
