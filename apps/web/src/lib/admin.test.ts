import { describe, expect, it } from 'vitest';
import { auditLabel, describeAudit } from './admin';

const nbsp = (s: string) => s.replace(/ /g, ' ');

describe('describeAudit', () => {
  it('describes balance changes', () => {
    expect(
      nbsp(
        describeAudit({
          action: 'user.credit',
          payload: { email: 'bia@x.com', deltaCents: 5000, balanceBefore: 0, balanceAfter: 5000, note: 'Bônus' },
        }),
      ),
    ).toBe('bia@x.com: +R$ 50,00 (saldo R$ 0,00 → R$ 50,00) — “Bônus”');
    expect(
      nbsp(describeAudit({ action: 'user.debit', payload: { email: 'b@x', deltaCents: -100, balanceBefore: 300, balanceAfter: 200 } })),
    ).toBe('b@x: −R$ 1,00 (saldo R$ 3,00 → R$ 2,00)');
  });

  it('describes blocks and asset edits', () => {
    expect(describeAudit({ action: 'user.block', payload: { email: 'b@x' } })).toBe('b@x');
    expect(
      describeAudit({
        action: 'asset.update',
        payload: { symbol: 'BTCUSDT', before: { payoutPct: 87, enabled: true }, after: { payoutPct: 90, enabled: false } },
      }),
    ).toBe('BTCUSDT: payout 87% → 90%, desativado');
  });

  it('falls back to JSON for unexpected payloads', () => {
    expect(describeAudit({ action: 'user.credit', payload: { foo: 1 } })).toBe('{"foo":1}');
    expect(describeAudit({ action: 'other', payload: {} })).toBe('{}');
    expect(auditLabel('user.unblock')).toBe('Desbloqueio de usuário');
    expect(auditLabel('x.y')).toBe('x.y');
  });
});
