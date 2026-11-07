import type { AuditAction, AuditEntryView } from '@traderoom/shared';
import { formatMoney, formatSignedMoney } from './format';

export const AUDIT_LABEL: Record<AuditAction, string> = {
  'user.credit': 'Crédito de saldo',
  'user.debit': 'Débito de saldo',
  'user.block': 'Bloqueio de usuário',
  'user.unblock': 'Desbloqueio de usuário',
  'asset.update': 'Alteração de ativo',
  'withdrawal.approve': 'Saque aprovado',
  'withdrawal.reject': 'Saque recusado',
  'kyc.approve': 'Verificação aprovada',
  'kyc.reject': 'Verificação recusada',
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

/** One readable line per audit entry; unknown shapes fall back to the raw JSON. */
export function describeAudit(e: Pick<AuditEntryView, 'action' | 'payload'>): string {
  const p = e.payload;
  switch (e.action) {
    case 'user.credit':
    case 'user.debit': {
      const delta = num(p.deltaCents);
      const before = num(p.balanceBefore);
      const after = num(p.balanceAfter);
      if (delta === null || before === null || after === null) break;
      const note = str(p.note);
      return `${str(p.email)}: ${formatSignedMoney(delta)} (saldo ${formatMoney(before)} → ${formatMoney(after)})${note ? ` — “${note}”` : ''}`;
    }
    case 'user.block':
    case 'user.unblock':
      if (!str(p.email)) break;
      return str(p.email);
    case 'kyc.approve':
      if (!str(p.email)) break;
      return str(p.email);
    case 'kyc.reject':
      if (!str(p.email)) break;
      return `${str(p.email)}${str(p.reason) ? ` — “${str(p.reason)}”` : ''}`;
    case 'asset.update': {
      const b = obj(p.before);
      const a = obj(p.after);
      const parts: string[] = [];
      if (b.payoutPct !== a.payoutPct) parts.push(`payout ${String(b.payoutPct)}% → ${String(a.payoutPct)}%`);
      if (b.enabled !== a.enabled) parts.push(a.enabled ? 'ativado' : 'desativado');
      if (a.otcVolPctHour !== undefined && b.otcVolPctHour !== a.otcVolPctHour)
        parts.push(`volatilidade ${String(b.otcVolPctHour)}%/h → ${String(a.otcVolPctHour)}%/h`);
      if (!str(p.symbol)) break;
      return `${str(p.symbol)}: ${parts.join(', ') || 'sem mudança'}`;
    }
  }
  return JSON.stringify(p);
}

export function auditLabel(action: string): string {
  return (AUDIT_LABEL as Record<string, string>)[action] ?? action;
}
