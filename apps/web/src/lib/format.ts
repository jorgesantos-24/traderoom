/**
 * Every time on screen is Brasília time (UTC-3), whatever the visitor's computer is set to,
 * so charts, orders and history line up with TradingView's default for Brazil.
 */
export const TIME_ZONE = 'America/Sao_Paulo';

/** Balances, stakes and payouts are in US dollars ("US$ 10,00"); Pix amounts are in reais. */
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' });
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const rate = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const dateTime = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZone: TIME_ZONE,
});
const time = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: TIME_ZONE });
const shortDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: TIME_ZONE });

export function formatMoney(cents: number): string {
  return money.format(cents / 100);
}

/** Reais, for Pix amounts: "R$ 50,00". */
export function formatBrl(cents: number): string {
  return brl.format(cents / 100);
}

/** BRL per dollar: "US$ 1 = R$ 5,5035". */
export function formatFxRate(brlPerUsd: number): string {
  return `US$ 1 = R$ ${rate.format(brlPerUsd)}`;
}

/** BRL cents → USD cents at `rate`, rounded down (same as the server). */
export const brlToUsdCents = (brlCents: number, brlPerUsd: number): number => Math.floor(brlCents / brlPerUsd + 1e-9);
/** USD cents → BRL cents at `rate`, rounded down (same as the server). */
export const usdToBrlCents = (usdCents: number, brlPerUsd: number): number => Math.floor(usdCents * brlPerUsd + 1e-9);

/** Signed amount, e.g. "+US$ 8,70" / "−US$ 10,00". */
export function formatSignedMoney(cents: number): string {
  if (cents === 0) return money.format(0);
  return `${cents > 0 ? '+' : '−'}${money.format(Math.abs(cents) / 100)}`;
}

/** Decimal places that keep ~6 significant digits for typical crypto quotes. */
export function pricePrecision(price: number): number {
  const abs = Math.abs(price);
  // Binance's tick size on USDT pairs: 0.01 from 10 up (BTC, ETH, SOL), 0.0001 below (XRP).
  if (abs >= 10) return 2;
  if (abs >= 1) return 4;
  if (abs >= 0.01) return 5;
  return 8;
}

export function formatPrice(price: number | string, precision?: number): string {
  const n = typeof price === 'string' ? Number(price) : price;
  if (!Number.isFinite(n)) return '—';
  const digits = precision ?? pricePrecision(n);
  return n.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** "m:ss" for countdowns; never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatDuration(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}min`;
  return `${sec}s`;
}

export function formatDateTime(iso: string | number): string {
  return dateTime.format(new Date(iso));
}

export function formatTime(iso: string | number): string {
  return time.format(new Date(iso));
}

/** "15/07/26". */
export function formatShortDate(iso: string | number): string {
  return shortDate.format(new Date(iso));
}

/**
 * Parses a pt-BR or plain amount ("25", "25,50", "1.000,00", "25.5") into cents.
 * Returns null when it is not a positive amount with at most 2 decimals.
 */
export function parseMoneyToCents(input: string): number | null {
  let s = input.trim().replace(/^(R|US)?\$\s*/i, '');
  if (s === '') return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [int = '0', frac = ''] = s.split('.');
  const cents = Number(int) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export const DIRECTION_LABEL = { call: 'Compra', put: 'Venda' } as const;

export const STATUS_LABEL = { open: 'Aberta', won: 'Ganhou', lost: 'Perdeu', void: 'Anulada' } as const;

export const ACCOUNT_LABEL = { real: 'Conta real', demo: 'Conta demo' } as const;

export const LEDGER_LABEL = {
  credit: 'Crédito',
  debit: 'Débito',
  stake: 'Entrada em ordem',
  payout: 'Pagamento de ordem',
  refund: 'Reembolso',
  adjust: 'Ajuste',
  deposit: 'Depósito',
  deposit_reversal: 'Estorno de depósito',
  withdrawal: 'Saque',
  withdrawal_return: 'Saque devolvido',
} as const;

export const DEPOSIT_STATUS_LABEL = {
  pending: 'Aguardando pagamento',
  paid: 'Confirmado',
  expired: 'Expirado',
  failed: 'Falhou',
  reversed: 'Estornado',
} as const;

export const WITHDRAWAL_STATUS_LABEL = {
  requested: 'Em análise',
  approved: 'Aprovado',
  processing: 'Enviando',
  completed: 'Concluído',
  rejected: 'Recusado',
  failed: 'Falhou (devolvido)',
  returned: 'Devolvido pelo banco',
} as const;

export const PIX_KEY_LABEL = { CPF: 'CPF', CNPJ: 'CNPJ', EMAIL: 'E-mail', PHONE: 'Celular', RANDOM: 'Chave aleatória' } as const;

export const KYC_STATUS_LABEL = {
  none: 'Não verificada',
  pending: 'Em análise',
  approved: 'Verificada',
  rejected: 'Recusada',
  draft: 'Rascunho',
} as const;

export const KYC_DOC_LABEL = { RG: 'RG', CNH: 'CNH', RNE: 'RNE / CRNM', PASSAPORTE: 'Passaporte' } as const;

export const KYC_FILE_LABEL = {
  doc_front: 'Frente do documento',
  doc_back: 'Verso do documento',
  selfie: 'Selfie com o documento',
} as const;
