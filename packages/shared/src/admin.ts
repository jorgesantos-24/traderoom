import type { AssetCategory } from './orders.js';
import { z } from 'zod';
import type { UserRole } from './auth.js';
import { MAX_STAKE_CENTS_HARD, PAGE_DEFAULT_LIMIT, PAGE_MAX_LIMIT } from './orders.js';

/** Largest single manual credit or debit, in cents (US$ 1.000.000,00). */
export const ADMIN_MAX_ADJUST_CENTS = MAX_STAKE_CENTS_HARD;
export const PAYOUT_PCT_MIN = 50;
export const PAYOUT_PCT_MAX = 95;
/** OTC volatility bounds, % per hour (matches the database check). */
export const OTC_VOL_MIN = 0.1;
export const OTC_VOL_MAX = 20;

const limit = z.coerce
  .number()
  .int('O limite precisa ser inteiro.')
  .min(1, 'O limite mínimo é 1.')
  .max(PAGE_MAX_LIMIT, `O limite máximo é ${PAGE_MAX_LIMIT}.`)
  .default(PAGE_DEFAULT_LIMIT);

export const AdminUsersQuery = z.object({
  q: z.string().trim().max(100, 'Busca muito longa.').optional(),
  cursor: z.string().max(200).optional(),
  limit,
});
export type AdminUsersQuery = z.infer<typeof AdminUsersQuery>;

export const UserIdParams = z.object({ id: z.uuid('Usuário inválido.') });
export const AssetIdParams = z.object({ id: z.coerce.number().int().positive('Ativo inválido.') });

export const AdminCreditInput = z.object({
  deltaCents: z
    .number('Informe o valor.')
    .int('O valor deve ser em centavos inteiros.')
    .refine((v) => v !== 0, 'O valor não pode ser zero.')
    .refine((v) => Math.abs(v) <= ADMIN_MAX_ADJUST_CENTS, 'Valor acima do máximo permitido.'),
  note: z.string('Informe o motivo.').trim().min(3, 'Descreva o motivo (mínimo 3 caracteres).').max(200, 'Motivo muito longo.'),
});
export type AdminCreditInput = z.infer<typeof AdminCreditInput>;

/** Body of POST /api/admin/users/:id/block. Empty body blocks; `{ "blocked": false }` unblocks. */
export const AdminBlockInput = z.object({ blocked: z.boolean('blocked deve ser true ou false.').default(true) }).default({ blocked: true });
export type AdminBlockInput = z.infer<typeof AdminBlockInput>;

export const AdminAssetPatch = z
  .object({
    payoutPct: z
      .number('Informe o payout.')
      .int('O payout deve ser inteiro.')
      .min(PAYOUT_PCT_MIN, `O payout mínimo é ${PAYOUT_PCT_MIN}%.`)
      .max(PAYOUT_PCT_MAX, `O payout máximo é ${PAYOUT_PCT_MAX}%.`)
      .optional(),
    enabled: z.boolean('enabled deve ser true ou false.').optional(),
    /** OTC only: typical move per hour, in percent. */
    otcVolPctHour: z
      .number('Informe a volatilidade.')
      .min(OTC_VOL_MIN, `A volatilidade mínima é ${OTC_VOL_MIN}%/h.`)
      .max(OTC_VOL_MAX, `A volatilidade máxima é ${OTC_VOL_MAX}%/h.`)
      .optional(),
  })
  .strict()
  .refine(
    (p) => p.payoutPct !== undefined || p.enabled !== undefined || p.otcVolPctHour !== undefined,
    'Envie payoutPct, enabled e/ou otcVolPctHour.',
  );
export type AdminAssetPatch = z.infer<typeof AdminAssetPatch>;

export const AUDIT_ACTIONS = [
  'user.credit',
  'user.debit',
  'user.block',
  'user.unblock',
  'asset.update',
  'withdrawal.approve',
  'withdrawal.reject',
  'kyc.approve',
  'kyc.reject',
  'otc.override',
  'otc.override.release',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AdminAuditQuery = z.object({
  action: z.enum(AUDIT_ACTIONS, 'Ação inválida.').optional(),
  cursor: z.string().max(200).optional(),
  limit,
});
export type AdminAuditQuery = z.infer<typeof AdminAuditQuery>;

export interface AdminUserView {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: 'active' | 'blocked';
  createdAt: string;
  balanceCents: number;
  openOrders: number;
}

export interface AdminAssetView {
  id: number;
  symbol: string;
  display: string;
  payoutPct: number;
  enabled: boolean;
  sort: number;
  kind: 'market' | 'otc';
  category: AssetCategory;
  /** OTC only. */
  otcVolPctHour: number | null;
  /** Built-in trend, % per hour (0 for everything except Bull/Bear indices). */
  otcDriftPctHour: number;
}

export interface AuditEntryView {
  id: string;
  adminId: string;
  adminEmail: string;
  action: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
