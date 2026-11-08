import { z } from 'zod';
import type { KycStatus } from './kyc.js';
import { PAGE_DEFAULT_LIMIT, PAGE_MAX_LIMIT } from './orders.js';

export type DepositStatus = 'pending' | 'paid' | 'expired' | 'failed' | 'reversed';
export type WithdrawalStatus = 'requested' | 'approved' | 'processing' | 'completed' | 'rejected' | 'failed' | 'returned';
export const PIX_KEY_TYPES = ['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'RANDOM'] as const;
export type PixKeyType = (typeof PIX_KEY_TYPES)[number];

/** Digits only. */
export const onlyDigits = (s: string): string => s.replace(/\D/g, '');

/** Brazilian CPF check digits. */
export function isValidCpf(input: string): boolean {
  const cpf = onlyDigits(input);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const digit = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}

export function isValidCnpj(input: string): boolean {
  const c = onlyDigits(input);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const digit = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = w.reduce((s, wi, i) => s + wi * Number(c[i]), 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return digit(12) === Number(c[12]) && digit(13) === Number(c[13]);
}

/** Normalizes a Pix key as the gateway expects it, or returns null when it is not valid for its type. */
export function normalizePixKey(type: PixKeyType, key: string): string | null {
  const k = key.trim();
  switch (type) {
    case 'CPF':
      return isValidCpf(k) ? onlyDigits(k) : null;
    case 'CNPJ':
      return isValidCnpj(k) ? onlyDigits(k) : null;
    case 'EMAIL':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(k) && k.length <= 77 ? k.toLowerCase() : null;
    case 'PHONE': {
      // Brazilian mobile/landline: DDD + 8 or 9 digits, sent as +55...
      const d = onlyDigits(k).replace(/^55(?=\d{10,11}$)/, '');
      return /^\d{10,11}$/.test(d) ? `+55${d}` : null;
    }
    case 'RANDOM':
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k) ? k.toLowerCase() : null;
  }
}

const cents = (what: string) =>
  z.number(`Informe o valor ${what}.`).int('O valor deve ser em centavos inteiros.').positive('O valor deve ser positivo.');

export const CreateDepositInput = z.object({
  /** Reais (BRL cents) the Pix charge is for; the balance is credited in dollars. */
  amountCents: cents('do depósito'),
  /** Needed only while the user has no CPF on file. */
  cpf: z.string().trim().max(20).optional(),
});
export type CreateDepositInput = z.infer<typeof CreateDepositInput>;

export const CreateWithdrawalInput = z.object({
  /** Dollars (USD cents) taken from the balance; the Pix is sent in reais. */
  amountCents: cents('do saque'),
  pixKeyType: z.enum(PIX_KEY_TYPES, 'Tipo de chave Pix inválido.'),
  pixKey: z.string('Informe a chave Pix.').trim().min(1, 'Informe a chave Pix.').max(100, 'Chave Pix muito longa.'),
});
export type CreateWithdrawalInput = z.infer<typeof CreateWithdrawalInput>;

export const PaymentIdParams = z.object({ id: z.uuid('Identificador inválido.') });

export const AdminWithdrawalsQuery = z.object({
  status: z.enum(['open', 'all'], 'Filtro inválido.').default('open'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_MAX_LIMIT).default(PAGE_DEFAULT_LIMIT),
});
export type AdminWithdrawalsQuery = z.infer<typeof AdminWithdrawalsQuery>;

export const AdminRejectInput = z.object({
  note: z.string('Informe o motivo.').trim().min(3, 'Descreva o motivo (mínimo 3 caracteres).').max(200, 'Motivo muito longo.'),
});

/** What the deposit/withdraw screens need before the user types anything. */
export interface PaymentsInfo {
  enabled: boolean;
  /** Deposits and withdrawals need 'approved'. */
  kycStatus: KycStatus;
  /** Masked (***.456.789-**), or null when the user still has to give one. */
  cpf: string | null;
  /** BRL cents. */
  depositMinCents: number;
  /** BRL cents. */
  depositMaxCents: number;
  /** USD cents. */
  withdrawMinCents: number;
  /** BRL per US$ 1 for deposits right now; null when no quote is available (deposits are then paused). */
  depositRate: number | null;
  /** BRL per US$ 1 for withdrawals right now; null when no quote is available. */
  withdrawRate: number | null;
}

export interface DepositView {
  id: string;
  /** BRL cents charged by Pix. */
  amountCents: number;
  /** USD cents: what was credited, or what will be credited once paid. */
  usdCents: number;
  /** BRL per US$ 1 used for this deposit. */
  fxRate: number;
  status: DepositStatus;
  /** Pix "copia e cola"; turn it into the QR image on the client. */
  pixCode: string | null;
  expiresAt: string | null;
  createdAt: string;
  paidAt: string | null;
}

export interface WithdrawalView {
  id: string;
  /** USD cents taken from the balance. */
  amountCents: number;
  /** BRL cents sent by Pix. */
  pixAmountCents: number;
  /** BRL per US$ 1 used for this withdrawal. */
  fxRate: number;
  pixKeyType: PixKeyType;
  pixKey: string;
  status: WithdrawalStatus;
  note: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AdminWithdrawalView extends WithdrawalView {
  userId: string;
  userEmail: string;
  userName: string;
  userCpf: string | null;
  lastError: string | null;
  providerStatus: string | null;
}
