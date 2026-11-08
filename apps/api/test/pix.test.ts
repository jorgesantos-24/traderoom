import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isValidCnpj, isValidCpf, normalizePixKey } from '@traderoom/shared';
import { isPayoutPayload, parseChargeState, parsePayoutState, verifySignature } from '../src/lib/novus.js';

describe('Pix keys and documents', () => {
  it('checks CPF and CNPJ digits', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('529.982.247-24')).toBe(false);
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11.222.333/0001-80')).toBe(false);
  });

  it('normalizes each key type or rejects it', () => {
    expect(normalizePixKey('CPF', '529.982.247-25')).toBe('52998224725');
    expect(normalizePixKey('PHONE', '+55 (21) 98888-7777')).toBe('+5521988887777');
    expect(normalizePixKey('PHONE', '123')).toBeNull();
    expect(normalizePixKey('EMAIL', 'X@Y.com')).toBe('x@y.com');
    expect(normalizePixKey('EMAIL', 'nope')).toBeNull();
    expect(normalizePixKey('RANDOM', '123e4567-E89B-12d3-a456-426614174000')).toBe('123e4567-e89b-12d3-a456-426614174000');
  });
});

describe('Novus payloads', () => {
  it('verifies the HMAC-SHA256 hex signature of the raw body', () => {
    const body = Buffer.from('{"id":"x","status":"paid"}');
    const sig = createHmac('sha256', 'k').update(body).digest('hex');
    expect(verifySignature(body, sig, 'k')).toBe(true);
    expect(verifySignature(body, sig.toUpperCase(), 'k')).toBe(true);
    expect(verifySignature(body, sig, 'other')).toBe(false);
    expect(verifySignature(body, undefined, 'k')).toBe(false);
    expect(verifySignature(body, 'short', 'k')).toBe(false);
  });

  it('reads postbacks, envelopes and API responses alike', () => {
    expect(parseChargeState({ id: 'a', status: 'paid', amount: 1990, external_id: 'e' })).toEqual({
      providerId: 'a',
      externalId: 'e',
      status: 'paid',
      amountCents: 1990,
    });
    expect(parseChargeState({ data: { invoice_id: 'b', status: 'pending', total_cents: 5000 } })).toMatchObject({
      providerId: 'b',
      amountCents: 5000,
    });
    const env = { event: 'withdrawal.completed', data: { id: 'p', status: 'completed', amount: 15000, net_amount: 14850 } };
    expect(isPayoutPayload(env)).toBe(true);
    expect(isPayoutPayload({ id: 'a', status: 'paid', amount: 1, event: 'invoice.paid' })).toBe(false);
    expect(parsePayoutState(env)).toMatchObject({ providerId: 'p', status: 'completed', amountCents: 15000 });
  });
});
