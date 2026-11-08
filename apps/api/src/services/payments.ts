import type pg from 'pg';
import {
  ErrorCode,
  isValidCpf,
  normalizePixKey,
  onlyDigits,
  type AdminWithdrawalView,
  type AdminWithdrawalsQuery,
  type CreateDepositInput,
  type CreateWithdrawalInput,
  type DepositStatus,
  type KycStatus,
  type DepositView,
  type LedgerKind,
  type Page,
  type PaymentsInfo,
  type PixKeyType,
  type WithdrawalStatus,
  type WithdrawalView,
} from '@traderoom/shared';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { inTransaction } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { brlToUsdCents, FxUnavailableError, usdToBrlCents, type FxService } from '../lib/fx.js';
import {
  GatewayError,
  isPayoutPayload,
  parseChargeState,
  parsePayoutState,
  verifySignature,
  type ChargeState,
  type PaymentGateway,
  type PayoutState,
} from '../lib/novus.js';
import { isoUs } from './orders.js';

export interface PaymentLimits {
  /** BRL cents (the Pix charge). */
  depositMinCents: number;
  /** BRL cents (the Pix charge). */
  depositMaxCents: number;
  /** USD cents (taken from the balance). */
  withdrawMinCents: number;
  /** Pending (unpaid) Pix charges a user may have at once. */
  maxPendingDeposits: number;
  /** Withdrawals waiting for review or the bank. */
  maxOpenWithdrawals: number;
}

export const DEFAULT_PAYMENT_LIMITS: PaymentLimits = {
  depositMinCents: 1_000,
  depositMaxCents: 5_000_000,
  withdrawMinCents: 500,
  maxPendingDeposits: 3,
  maxOpenWithdrawals: 3,
};

export interface PaymentServiceDeps {
  pool: pg.Pool;
  /** Null when no gateway key is configured: deposits and withdrawals are off. */
  gateway: PaymentGateway | null;
  /** Secrets that may sign incoming webhooks: the private key (postbacks) and, optionally, a global webhook secret. */
  webhookSecrets: string[];
  /** Absolute URL the gateway posts status changes to; null in development (status is then pulled on demand). */
  postbackUrl: string | null;
  limits?: PaymentLimits;
  /** Dollar quote: balances are in USD, Pix moves BRL. */
  fx: FxService;
  /** Throws unless the user passed identity verification (KYC). Omitted = no check. */
  requireKyc?: (userId: string) => Promise<void>;
}

export interface PaymentService {
  info(userId: string): Promise<PaymentsInfo>;
  createDeposit(userId: string, input: CreateDepositInput): Promise<DepositView>;
  /** Pulls the latest status from the gateway while the charge is unpaid. */
  getDeposit(userId: string, id: string): Promise<DepositView>;
  listDeposits(userId: string): Promise<DepositView[]>;
  requestWithdrawal(userId: string, input: CreateWithdrawalInput): Promise<WithdrawalView>;
  listWithdrawals(userId: string): Promise<WithdrawalView[]>;
  adminList(q: AdminWithdrawalsQuery): Promise<Page<AdminWithdrawalView>>;
  approve(adminId: string, id: string): Promise<AdminWithdrawalView>;
  reject(adminId: string, id: string, note: string): Promise<AdminWithdrawalView>;
  refreshWithdrawal(id: string): Promise<AdminWithdrawalView>;
  /** Verifies and applies a gateway notification. Returns false for a bad signature. */
  handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<boolean>;
  applyChargeState(state: ChargeState): Promise<void>;
  applyPayoutState(state: PayoutState): Promise<void>;
}

const disabled = () => new AppError(503, ErrorCode.Unavailable, 'Depósitos e saques ainda não estão disponíveis.');
const gatewayFailed = (what: string) =>
  new AppError(502, ErrorCode.Unavailable, `Não foi possível ${what} agora. Tente novamente em instantes.`);
const fmt = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtUsd = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'USD' });
const fmtRate = (r: number) => r.toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const noQuote = () => new AppError(503, ErrorCode.Unavailable, 'Cotação do dólar indisponível no momento. Tente novamente em instantes.');
export const maskCpf = (cpf: string): string => `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`;

interface DepositRow {
  id: string;
  user_id: string;
  amount_cents: string;
  status: DepositStatus;
  provider_id: string | null;
  pix_code: string | null;
  expires_at: string | null;
  credited_cents: string | null;
  fx_rate: string;
  created_at: string;
  paid_at: string | null;
}
const DEPOSIT_COLS = `id, user_id, amount_cents, status, provider_id, pix_code, ${isoUs('expires_at')} as expires_at, credited_cents, fx_rate,
  ${isoUs('created_at')} as created_at, ${isoUs('paid_at')} as paid_at`;
const toDeposit = (r: DepositRow): DepositView => ({
  id: r.id,
  amountCents: Number(r.amount_cents),
  usdCents: r.credited_cents !== null ? Number(r.credited_cents) : brlToUsdCents(Number(r.amount_cents), Number(r.fx_rate)),
  fxRate: Number(r.fx_rate),
  status: r.status,
  pixCode: r.status === 'pending' ? r.pix_code : null,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  paidAt: r.paid_at,
});

interface WithdrawalRow {
  id: string;
  user_id: string;
  amount_cents: string;
  pix_amount_cents: string;
  fx_rate: string;
  pix_key: string;
  pix_key_type: PixKeyType;
  status: WithdrawalStatus;
  provider_id: string | null;
  provider_status: string | null;
  note: string | null;
  last_error: string | null;
  created_at: string;
  completed_at: string | null;
  email?: string;
  name?: string;
  cpf?: string | null;
}
const W_COLS = `w.id, w.user_id, w.amount_cents, w.pix_amount_cents, w.fx_rate, w.pix_key, w.pix_key_type, w.status, w.provider_id, w.provider_status, w.note,
  w.last_error, ${isoUs('w.created_at')} as created_at, ${isoUs('w.completed_at')} as completed_at`;
const toWithdrawal = (r: WithdrawalRow): WithdrawalView => ({
  id: r.id,
  amountCents: Number(r.amount_cents),
  pixAmountCents: Number(r.pix_amount_cents),
  fxRate: Number(r.fx_rate),
  pixKeyType: r.pix_key_type,
  pixKey: r.pix_key,
  status: r.status,
  note: r.note,
  createdAt: r.created_at,
  completedAt: r.completed_at,
});
const toAdminWithdrawal = (r: WithdrawalRow): AdminWithdrawalView => ({
  ...toWithdrawal(r),
  userId: r.user_id,
  userEmail: r.email ?? '',
  userName: r.name ?? '',
  userCpf: r.cpf ?? null,
  lastError: r.last_error,
  providerStatus: r.provider_status,
});

/** Moves money on the user's real account and writes the ledger row, under the account lock. */
async function moveReal(
  c: pg.PoolClient,
  userId: string,
  delta: number,
  kind: LedgerKind,
  note: string | null,
  ref: { depositId?: string; withdrawalId?: string },
): Promise<number> {
  const { rows } = await c.query<{ balance_cents: string }>(
    `select balance_cents from accounts where user_id = $1 and kind = 'real' for update`,
    [userId],
  );
  if (!rows[0]) throw new Error(`real account missing for user ${userId}`);
  const after = Number(rows[0].balance_cents) + delta;
  if (after < 0) throw new AppError(400, ErrorCode.InsufficientBalance, 'Saldo insuficiente.');
  await c.query(`update accounts set balance_cents = $2 where user_id = $1 and kind = 'real'`, [userId, after]);
  await c.query(
    `insert into ledger (user_id, delta_cents, balance_after, kind, note, account, deposit_id, withdrawal_id)
     values ($1, $2, $3, $4, $5, 'real', $6, $7)`,
    [userId, delta, after, kind, note, ref.depositId ?? null, ref.withdrawalId ?? null],
  );
  return after;
}

export function createPaymentService(deps: PaymentServiceDeps): PaymentService {
  const { pool, gateway } = deps;
  const limits = deps.limits ?? DEFAULT_PAYMENT_LIMITS;

  async function depositById(db: pg.Pool | pg.PoolClient, id: string, lock = false): Promise<DepositRow | null> {
    const { rows } = await db.query<DepositRow>(`select ${DEPOSIT_COLS} from deposits where id = $1${lock ? ' for update' : ''}`, [id]);
    return rows[0] ?? null;
  }

  async function adminWithdrawal(db: pg.Pool | pg.PoolClient, id: string): Promise<AdminWithdrawalView> {
    const { rows } = await db.query<WithdrawalRow>(
      `select ${W_COLS}, u.email::text as email, u.name, u.cpf from withdrawals w join users u on u.id = w.user_id where w.id = $1`,
      [id],
    );
    if (!rows[0]) throw new AppError(404, ErrorCode.NotFound, 'Saque não encontrado.');
    return toAdminWithdrawal(rows[0]);
  }

  async function audit(c: pg.PoolClient, adminId: string, action: string, payload: Record<string, unknown>) {
    await c.query('insert into admin_audit (admin_id, action, payload) values ($1, $2, $3)', [adminId, action, JSON.stringify(payload)]);
  }

  /** BRL per dollar for this side, or 503 when no quote can be had. */
  async function currentQuote(side: 'deposit' | 'withdraw'): Promise<number> {
    try {
      const q = await deps.fx.quote();
      return side === 'deposit' ? q.depositRate : q.withdrawRate;
    } catch (err) {
      if (err instanceof FxUnavailableError) throw noQuote();
      throw err;
    }
  }

  const service: PaymentService = {
    async info(userId) {
      const { rows } = await pool.query<{ cpf: string | null; kyc_status: KycStatus }>('select cpf, kyc_status from users where id = $1', [
        userId,
      ]);
      const cpf = rows[0]?.cpf ?? null;
      const quote = await deps.fx.quote().catch((err: unknown) => {
        if (err instanceof FxUnavailableError) return null;
        throw err;
      });
      return {
        enabled: gateway !== null,
        kycStatus: rows[0]?.kyc_status ?? 'none',
        cpf: cpf ? maskCpf(cpf) : null,
        depositMinCents: limits.depositMinCents,
        depositMaxCents: limits.depositMaxCents,
        withdrawMinCents: limits.withdrawMinCents,
        depositRate: quote?.depositRate ?? null,
        withdrawRate: quote?.withdrawRate ?? null,
      };
    },

    async createDeposit(userId, input) {
      if (!gateway) throw disabled();
      await deps.requireKyc?.(userId);
      if (input.amountCents < limits.depositMinCents || input.amountCents > limits.depositMaxCents) {
        throw new AppError(
          400,
          ErrorCode.ValidationFailed,
          `amountCents: o depósito deve ser entre ${fmt(limits.depositMinCents)} e ${fmt(limits.depositMaxCents)}.`,
        );
      }
      const rate = await currentQuote('deposit');

      const deposit = await inTransaction(pool, async (c) => {
        const u = await c.query<{ name: string; email: string; cpf: string | null }>(
          'select name, email::text as email, cpf from users where id = $1 for update',
          [userId],
        );
        const user = u.rows[0];
        if (!user) throw new AppError(401, ErrorCode.Unauthorized, 'Sessão inválida ou expirada.');
        let cpf = user.cpf;
        if (!cpf) {
          if (!input.cpf || !isValidCpf(input.cpf)) throw new AppError(400, ErrorCode.ValidationFailed, 'cpf: informe um CPF válido.');
          cpf = onlyDigits(input.cpf);
          const taken = await c.query('select 1 from users where cpf = $1 and id <> $2', [cpf, userId]);
          if (taken.rowCount) throw new AppError(409, ErrorCode.Conflict, 'cpf: este CPF já está vinculado a outra conta.');
          await c.query('update users set cpf = $2 where id = $1', [userId, cpf]);
        }
        const pending = await c.query<{ n: string }>(
          `select count(*) as n from deposits where user_id = $1 and status = 'pending' and created_at > now() - interval '1 hour'`,
          [userId],
        );
        if (Number(pending.rows[0]?.n) >= limits.maxPendingDeposits) {
          throw new AppError(429, ErrorCode.RateLimited, 'Você já tem depósitos aguardando pagamento. Pague um deles ou aguarde expirar.');
        }
        const ins = await c.query<{ id: string }>(
          'insert into deposits (user_id, amount_cents, fx_rate) values ($1, $2, $3) returning id',
          [userId, input.amountCents, rate],
        );
        return { id: ins.rows[0]!.id, payer: { name: user.name, email: user.email, cpf } };
      });

      try {
        const charge = await gateway.createPixCharge({
          externalId: deposit.id,
          amountCents: input.amountCents,
          payer: deposit.payer,
          postbackUrl: deps.postbackUrl,
        });
        await pool.query(
          `update deposits set provider_id = $2, pix_code = $3, expires_at = $4, provider_status = $5, updated_at = now() where id = $1`,
          [deposit.id, charge.providerId, charge.pixCode, charge.expiresAt, charge.status],
        );
      } catch (err) {
        await pool.query(`update deposits set status = 'failed', provider_status = $2, updated_at = now() where id = $1`, [
          deposit.id,
          err instanceof Error ? err.message.slice(0, 200) : 'erro',
        ]);
        throw gatewayFailed('gerar o Pix');
      }
      const row = await depositById(pool, deposit.id);
      return toDeposit(row!);
    },

    async getDeposit(userId, id) {
      let row = await depositById(pool, id);
      if (!row || row.user_id !== userId) throw new AppError(404, ErrorCode.NotFound, 'Depósito não encontrado.');
      if (row.status === 'pending' && row.provider_id && gateway) {
        try {
          await service.applyChargeState(await gateway.getCharge(row.provider_id));
          row = (await depositById(pool, id)) ?? row;
        } catch (err) {
          // The webhook will still arrive; show the last known state.
          if (!(err instanceof GatewayError)) throw err;
        }
      }
      return toDeposit(row);
    },

    async listDeposits(userId) {
      const { rows } = await pool.query<DepositRow>(
        `select ${DEPOSIT_COLS} from deposits where user_id = $1 and provider_id is not null order by created_at desc limit 20`,
        [userId],
      );
      return rows.map(toDeposit);
    },

    async requestWithdrawal(userId, input) {
      if (!gateway) throw disabled();
      await deps.requireKyc?.(userId);
      if (input.amountCents < limits.withdrawMinCents) {
        throw new AppError(400, ErrorCode.ValidationFailed, `amountCents: o saque mínimo é ${fmtUsd(limits.withdrawMinCents)}.`);
      }
      const rate = await currentQuote('withdraw');
      const pixCents = usdToBrlCents(input.amountCents, rate);
      const key = normalizePixKey(input.pixKeyType, input.pixKey);
      if (!key) throw new AppError(400, ErrorCode.ValidationFailed, 'pixKey: chave Pix inválida para o tipo escolhido.');

      const id = await inTransaction(pool, async (c) => {
        // Lock the account first so parallel requests are counted one at a time.
        await c.query(`select 1 from accounts where user_id = $1 and kind = 'real' for update`, [userId]);
        const open = await c.query<{ n: string }>(
          `select count(*) as n from withdrawals where user_id = $1 and status in ('requested', 'approved', 'processing')`,
          [userId],
        );
        if (Number(open.rows[0]?.n) >= limits.maxOpenWithdrawals) {
          throw new AppError(429, ErrorCode.RateLimited, 'Você já tem saques em andamento. Aguarde a conclusão para pedir outro.');
        }
        const ins = await c.query<{ id: string }>(
          `insert into withdrawals (user_id, amount_cents, pix_amount_cents, fx_rate, pix_key, pix_key_type)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [userId, input.amountCents, pixCents, rate, key, input.pixKeyType],
        );
        const wid = ins.rows[0]!.id;
        await moveReal(
          c,
          userId,
          -input.amountCents,
          'withdrawal',
          `Saque Pix (${input.pixKeyType}): ${fmt(pixCents)} (US$ 1 = ${fmtRate(rate)})`,
          {
            withdrawalId: wid,
          },
        );
        return wid;
      });
      return toWithdrawal((await pool.query<WithdrawalRow>(`select ${W_COLS} from withdrawals w where w.id = $1`, [id])).rows[0]!);
    },

    async listWithdrawals(userId) {
      const { rows } = await pool.query<WithdrawalRow>(
        `select ${W_COLS} from withdrawals w where w.user_id = $1 order by w.created_at desc limit 20`,
        [userId],
      );
      return rows.map(toWithdrawal);
    },

    async adminList(q) {
      const cursor = decodeCursor(q.cursor);
      const { rows } = await pool.query<WithdrawalRow & { cursor_at: string }>(
        `select ${W_COLS}, u.email::text as email, u.name, u.cpf, ${isoUs('w.created_at')} as cursor_at
           from withdrawals w join users u on u.id = w.user_id
          where ($1 = 'all' or w.status in ('requested', 'approved', 'processing'))
            and ($2::timestamptz is null or (w.created_at, w.id) < ($2::timestamptz, $3::uuid))
          order by w.created_at desc, w.id desc
          limit $4`,
        [q.status, cursor?.at ?? null, cursor?.id ?? null, q.limit + 1],
      );
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        items: page.map(toAdminWithdrawal),
        nextCursor: rows.length > q.limit && last ? encodeCursor({ at: last.cursor_at, id: last.id }) : null,
      };
    },

    async approve(adminId, id) {
      if (!gateway) throw disabled();
      const w = await inTransaction(pool, async (c) => {
        const { rows } = await c.query<WithdrawalRow>(`select ${W_COLS} from withdrawals w where w.id = $1 for update`, [id]);
        const row = rows[0];
        if (!row) throw new AppError(404, ErrorCode.NotFound, 'Saque não encontrado.');
        // 'approved' without a gateway id = an earlier send failed; sending again is safe (same Idempotency-Key).
        if (!(row.status === 'requested' || (row.status === 'approved' && !row.provider_id))) {
          throw new AppError(409, ErrorCode.Conflict, 'Este saque já foi processado.');
        }
        if (row.status === 'requested') {
          await c.query(`update withdrawals set status = 'approved', reviewed_by = $2, updated_at = now() where id = $1`, [id, adminId]);
          await audit(c, adminId, 'withdrawal.approve', { withdrawalId: id, userId: row.user_id, amountCents: Number(row.amount_cents) });
        }
        return row;
      });

      try {
        const payout = await gateway.createPayout({
          externalId: w.id,
          amountCents: Number(w.pix_amount_cents),
          pixKey: w.pix_key,
          pixKeyType: w.pix_key_type,
          description: 'Saque',
          postbackUrl: deps.postbackUrl,
        });
        await pool.query(
          `update withdrawals set status = 'processing', provider_id = $2, provider_status = $3, last_error = null, updated_at = now()
            where id = $1 and status = 'approved'`,
          [id, payout.providerId, payout.status],
        );
        await service.applyPayoutState(payout);
      } catch (err) {
        await pool.query('update withdrawals set last_error = $2, updated_at = now() where id = $1', [
          id,
          err instanceof Error ? err.message.slice(0, 300) : 'erro',
        ]);
        if (err instanceof GatewayError) throw new AppError(502, ErrorCode.Unavailable, `A Novus recusou o envio: ${err.message}`);
        throw err;
      }
      return adminWithdrawal(pool, id);
    },

    async reject(adminId, id, note) {
      await inTransaction(pool, async (c) => {
        const { rows } = await c.query<WithdrawalRow>(`select ${W_COLS} from withdrawals w where w.id = $1 for update`, [id]);
        const row = rows[0];
        if (!row) throw new AppError(404, ErrorCode.NotFound, 'Saque não encontrado.');
        if (!(row.status === 'requested' || (row.status === 'approved' && !row.provider_id))) {
          throw new AppError(409, ErrorCode.Conflict, 'Este saque já foi enviado ao banco e não pode mais ser recusado.');
        }
        await c.query(`update withdrawals set status = 'rejected', note = $2, reviewed_by = $3, updated_at = now() where id = $1`, [
          id,
          note,
          adminId,
        ]);
        await moveReal(c, row.user_id, Number(row.amount_cents), 'withdrawal_return', `Saque recusado: ${note}`, { withdrawalId: id });
        await audit(c, adminId, 'withdrawal.reject', {
          withdrawalId: id,
          userId: row.user_id,
          amountCents: Number(row.amount_cents),
          note,
        });
      });
      return adminWithdrawal(pool, id);
    },

    async refreshWithdrawal(id) {
      const w = await adminWithdrawal(pool, id);
      const { rows } = await pool.query<{ provider_id: string | null }>('select provider_id from withdrawals where id = $1', [id]);
      const providerId = rows[0]?.provider_id;
      if (gateway && providerId) {
        try {
          await service.applyPayoutState(await gateway.getPayout(providerId));
        } catch (err) {
          if (err instanceof GatewayError) throw new AppError(502, ErrorCode.Unavailable, err.message);
          throw err;
        }
        return adminWithdrawal(pool, id);
      }
      return w;
    },

    async applyChargeState(state) {
      await inTransaction(pool, async (c) => {
        const { rows } = await c.query<DepositRow>(
          `select ${DEPOSIT_COLS} from deposits where provider_id = $1 or ($2::text ~ '^[0-9a-f-]{36}$' and id = $2::uuid) for update`,
          [state.providerId, state.externalId ?? ''],
        );
        const d = rows[0];
        if (!d) return;
        await c.query('update deposits set provider_status = $2, updated_at = now() where id = $1', [d.id, state.status]);
        const s = state.status;
        if (d.status === 'pending' && s === 'paid') {
          // Credit what was actually paid (the gateway keeps underpayments pending until accepted).
          const paid = state.amountCents && state.amountCents > 0 ? state.amountCents : Number(d.amount_cents);
          const rate = Number(d.fx_rate);
          const credit = brlToUsdCents(paid, rate);
          await c.query(`update deposits set status = 'paid', credited_cents = $2, paid_at = now() where id = $1`, [d.id, credit]);
          if (credit > 0) {
            await moveReal(c, d.user_id, credit, 'deposit', `Depósito Pix: ${fmt(paid)} (US$ 1 = ${fmtRate(rate)})`, { depositId: d.id });
          }
        } else if (d.status === 'pending' && (s === 'canceled' || s === 'cancelled' || s === 'expired')) {
          await c.query(`update deposits set status = 'expired' where id = $1`, [d.id]);
        } else if (d.status === 'pending' && (s === 'failed' || s === 'refused')) {
          await c.query(`update deposits set status = 'failed' where id = $1`, [d.id]);
        } else if (d.status === 'paid' && (s === 'refunded' || s === 'chargedback' || s === 'chargeback')) {
          // Money went back to the payer: take it back from the balance, as far as there is balance left.
          const bal = await c.query<{ b: string }>(
            `select balance_cents as b from accounts where user_id = $1 and kind = 'real' for update`,
            [d.user_id],
          );
          const credited = d.credited_cents !== null ? Number(d.credited_cents) : brlToUsdCents(Number(d.amount_cents), Number(d.fx_rate));
          const take = Math.min(credited, Number(bal.rows[0]?.b ?? 0));
          await c.query(`update deposits set status = 'reversed' where id = $1`, [d.id]);
          const short = credited - take;
          if (take > 0) {
            await moveReal(
              c,
              d.user_id,
              -take,
              'deposit_reversal',
              short > 0 ? `Depósito estornado (faltaram ${fmtUsd(short)})` : 'Depósito estornado',
              {
                depositId: d.id,
              },
            );
          }
        }
      });
    },

    async applyPayoutState(state) {
      await inTransaction(pool, async (c) => {
        const { rows } = await c.query<WithdrawalRow>(
          `select ${W_COLS} from withdrawals w
            where w.provider_id = $1 or ($2::text ~ '^[0-9a-f-]{36}$' and w.id = $2::uuid) for update`,
          [state.providerId, state.externalId ?? ''],
        );
        const w = rows[0];
        if (!w) return;
        await c.query(
          'update withdrawals set provider_status = $2, provider_id = coalesce(provider_id, $3), updated_at = now() where id = $1',
          [w.id, state.status, state.providerId],
        );
        const s = state.status;
        const inFlight = w.status === 'processing' || w.status === 'approved';
        if (inFlight && s === 'completed') {
          await c.query(`update withdrawals set status = 'completed', completed_at = now() where id = $1`, [w.id]);
        } else if (inFlight && (s === 'failed' || s === 'canceled' || s === 'cancelled')) {
          await c.query(`update withdrawals set status = 'failed' where id = $1`, [w.id]);
          await moveReal(c, w.user_id, Number(w.amount_cents), 'withdrawal_return', 'Saque não concluído pelo banco; valor devolvido.', {
            withdrawalId: w.id,
          });
        } else if ((w.status === 'completed' || inFlight) && s === 'refunded') {
          // The bank returns reais; give back the dollars they correspond to at the withdrawal's rate.
          const usd = Number(w.amount_cents);
          const back = state.refundedAmountCents != null ? Math.min(brlToUsdCents(state.refundedAmountCents, Number(w.fx_rate)), usd) : usd;
          await c.query(`update withdrawals set status = 'returned' where id = $1`, [w.id]);
          await moveReal(c, w.user_id, back, 'withdrawal_return', 'Saque devolvido pelo banco de destino.', { withdrawalId: w.id });
        }
      });
    },

    async handleWebhook(rawBody, signature) {
      if (!deps.webhookSecrets.some((s) => verifySignature(rawBody, signature, s))) return false;
      const body: unknown = JSON.parse(rawBody.toString('utf8'));
      if (isPayoutPayload(body)) await service.applyPayoutState(parsePayoutState(body));
      else await service.applyChargeState(parseChargeState(body));
      return true;
    },
  };
  return service;
}
