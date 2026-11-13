import type { AccountKind, AssetCategory, Direction, LedgerKind, OrderStatus } from './orders.js';
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
  'indicator.grant',
  'indicator.revoke',
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

// ---- premium indicators (shown only to users an admin let in) ----

/** Chart indicators hidden until an admin grants them to the user. Admins always have them. */
export const PREMIUM_INDICATORS = ['smc', 'patterns'] as const;
export type PremiumIndicator = (typeof PREMIUM_INDICATORS)[number];
export const PREMIUM_INDICATOR_LABEL: Record<PremiumIndicator, string> = {
  smc: 'Smart Money Concepts (SMC)',
  patterns: 'Figuras geométricas (padrões gráficos)',
};

const premiumIndicator = z.enum(PREMIUM_INDICATORS, 'Indicador inválido.');

export const AdminIndicatorGrant = z.object({
  email: z.string().trim().max(254, 'E-mail muito longo.').pipe(z.email('E-mail inválido.')),
  indicator: premiumIndicator,
});
export type AdminIndicatorGrant = z.infer<typeof AdminIndicatorGrant>;

export const IndicatorAccessParams = z.object({ userId: z.uuid('Usuário inválido.'), indicator: premiumIndicator });

export interface IndicatorAccessView {
  userId: string;
  email: string;
  name: string;
  indicator: PremiumIndicator;
  grantedAt: string;
  grantedByEmail: string | null;
}

/** GET /api/indicators/access: the premium indicators this user may use. */
export interface IndicatorAccessResponse {
  indicators: PremiumIndicator[];
}

// ---- Online users ----

/** How often the ws gateway rewrites its presence snapshot, and how long Redis keeps it. */
export const WS_PRESENCE_INTERVAL_MS = 5_000;
export const WS_PRESENCE_TTL_MS = 20_000;

/** One connected user, as the ws gateway sees it. */
export interface WsPresenceEntry {
  userId: string;
  /** Open WebSocket connections (tabs or devices). */
  connections: number;
  /** Epoch ms of the oldest open connection. */
  since: number;
  /** Assets the user's connections are subscribed to. */
  assets: string[];
}

/** What the ws gateway writes to `RedisKeys.wsPresence`. */
export interface WsPresenceSnapshot {
  /** Epoch ms when it was written. */
  at: number;
  users: WsPresenceEntry[];
}

export interface AdminOnlineUserView {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  balanceCents: number;
  connections: number;
  /** ISO time of the oldest open connection. */
  onlineSince: string;
  assets: string[];
}

export interface AdminOnlineResponse {
  users: AdminOnlineUserView[];
  /** ISO time of the snapshot; null when the price server has not published one (down or restarting). */
  updatedAt: string | null;
}

// ---- Activity log (every balance movement of every client) ----

/** Filters of the activity log; each group maps to ledger kinds. */
export const ACTIVITY_GROUPS = ['trades', 'deposits', 'withdrawals', 'adjustments'] as const;
export type ActivityGroup = (typeof ACTIVITY_GROUPS)[number];
export const ACTIVITY_GROUP_KINDS: Record<ActivityGroup, readonly LedgerKind[]> = {
  trades: ['stake', 'payout', 'refund'],
  deposits: ['deposit', 'deposit_reversal'],
  withdrawals: ['withdrawal', 'withdrawal_return'],
  adjustments: ['credit', 'debit', 'adjust'],
};

export const AdminActivityQuery = z.object({
  group: z.enum(ACTIVITY_GROUPS, 'Filtro inválido.').optional(),
  account: z.enum(['real', 'demo', 'all'], 'Conta inválida.').default('real'),
  q: z.string().trim().max(100, 'Busca muito longa.').optional(),
  cursor: z.string().max(200).optional(),
  limit,
});
export type AdminActivityQuery = z.infer<typeof AdminActivityQuery>;

export interface AdminActivityView {
  id: string;
  createdAt: string;
  userId: string;
  userName: string;
  userEmail: string;
  account: AccountKind;
  kind: LedgerKind;
  deltaCents: number;
  balanceAfterCents: number;
  note: string | null;
  /** The order behind a stake, payout or refund. */
  order: {
    id: string;
    asset: string;
    direction: Direction;
    status: OrderStatus;
    stakeCents: number;
    payoutPct: number;
    durationSec: number;
  } | null;
}

// ---- House results (what the platform won or lost against its clients) ----

export const AdminResultsQuery = z.object({
  tz: z.string().min(1).max(64).default('America/Sao_Paulo'),
});
export type AdminResultsQuery = z.infer<typeof AdminResultsQuery>;

export interface HousePeriodResult {
  /** Orders opened in the period ("entradas"). */
  entries: number;
  /** Distinct clients who opened at least one. */
  traders: number;
  volumeCents: number;
  won: number;
  lost: number;
  void: number;
  open: number;
  /** Stakes the house kept from losing orders. */
  collectedCents: number;
  /** Profit the house paid on winning orders (the stake itself goes back too, but it was the client's). */
  paidCents: number;
  /** collected − paid: positive, the house is up; negative, clients took money from it. */
  houseCents: number;
  depositsCents: number;
  depositsCount: number;
  withdrawalsCents: number;
  withdrawalsCount: number;
}

export interface HouseDay {
  /** YYYY-MM-DD in the requested time zone. */
  day: string;
  entries: number;
  volumeCents: number;
  houseCents: number;
}

export interface HouseClientResult {
  userId: string;
  name: string;
  email: string;
  entries: number;
  volumeCents: number;
  /** Client's net result: positive means they took money from the house. */
  netCents: number;
}

export interface AdminResultsResponse {
  tz: string;
  generatedAt: string;
  today: HousePeriodResult;
  week: HousePeriodResult;
  month: HousePeriodResult;
  /** Orders still running: if all of them win, the house pays `maxPayoutCents` in profit. */
  openNow: { orders: number; stakeCents: number; maxPayoutCents: number };
  /** Last 30 days, oldest first, every day present. */
  daily: HouseDay[];
  /** This month: clients who won the most, and who lost the most. */
  topWinners: HouseClientResult[];
  topLosers: HouseClientResult[];
}
