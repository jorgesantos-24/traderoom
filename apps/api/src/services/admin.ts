import type pg from 'pg';
import {
  ErrorCode,
  type AdminAssetPatch,
  type AdminAssetView,
  type AdminAuditQuery,
  type AdminUsersQuery,
  type AdminUserView,
  type AssetCategory,
  type AuditAction,
  type AuditEntryView,
  type IndicatorAccessView,
  type Page,
  type PremiumIndicator,
  PREMIUM_INDICATORS,
} from '@traderoom/shared';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { inTransaction } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { isoUs } from './orders.js';

export interface CreditResult {
  user: AdminUserView;
  ledgerId: string;
  /** True when an earlier request with the same Idempotency-Key already made this adjustment. */
  replayed: boolean;
}

export interface AdminService {
  listUsers(q: AdminUsersQuery): Promise<Page<AdminUserView>>;
  /**
   * Positive delta credits, negative debits. Refuses to take the balance below zero.
   * The same idempotency key with the same request replays the first result.
   */
  adjustBalance(adminId: string, userId: string, deltaCents: number, note: string, idempotencyKey: string): Promise<CreditResult>;
  setBlocked(adminId: string, userId: string, blocked: boolean): Promise<AdminUserView>;
  listAssets(): Promise<AdminAssetView[]>;
  updateAsset(adminId: string, assetId: number, patch: AdminAssetPatch): Promise<AdminAssetView>;
  listAudit(q: AdminAuditQuery): Promise<Page<AuditEntryView>>;
  /** Premium indicators this user may see: all of them for admins, the granted ones for others. */
  allowedIndicators(userId: string, role: 'user' | 'admin'): Promise<PremiumIndicator[]>;
  listIndicatorAccess(): Promise<IndicatorAccessView[]>;
  /** Grants by e-mail; granting twice is a no-op that returns the existing row. */
  grantIndicator(adminId: string, email: string, indicator: PremiumIndicator): Promise<IndicatorAccessView>;
  revokeIndicator(adminId: string, userId: string, indicator: PremiumIndicator): Promise<void>;
}

export interface AdminServiceDeps {
  pool: pg.Pool;
  /** Called after an asset change commits, so this process stops serving the cached list. */
  onAssetsChanged?: () => void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  status: 'active' | 'blocked';
  created_at: string;
  balance_cents: string;
  open_orders: string;
}

const USER_SELECT = `
  select u.id, u.email::text as email, u.name, u.role, u.status, ${isoUs('u.created_at')} as created_at,
         coalesce(a.balance_cents, 0) as balance_cents,
         (select count(*) from orders o where o.user_id = u.id and o.account = 'real' and o.status = 'open') as open_orders
    from users u
    left join accounts a on a.user_id = u.id and a.kind = 'real'`;

const toUser = (r: UserRow): AdminUserView => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  status: r.status,
  createdAt: r.created_at,
  balanceCents: Number(r.balance_cents),
  openOrders: Number(r.open_orders),
});

interface AssetRowDb {
  id: number;
  symbol: string;
  display: string;
  payout_pct: number;
  enabled: boolean;
  sort: number;
  kind: 'market' | 'otc';
  category: AssetCategory;
  otc_vol_pct_hour: string | null;
  otc_drift_pct_hour: string;
}

/** Trend at most 5% of the volatility (matches assets_otc_drift_cap). */
const OTC_DRIFT_MAX_RATIO = 0.05;
/** With that trend, always following it on a 30-min trade wins ~51.4%; at 93% payout the break-even is 51.8%. */
const OTC_TREND_PAYOUT_MAX = 93;

const toAsset = (r: AssetRowDb): AdminAssetView => ({
  id: r.id,
  symbol: r.symbol,
  display: r.display,
  payoutPct: r.payout_pct,
  enabled: r.enabled,
  sort: r.sort,
  kind: r.kind,
  category: r.category,
  otcDriftPctHour: Number(r.otc_drift_pct_hour),
  otcVolPctHour: r.otc_vol_pct_hour === null ? null : Number(r.otc_vol_pct_hour),
});

/** Escapes LIKE wildcards so a search for "a_b" or "50%" matches literally. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

interface PriorAdjustment {
  id: string;
  user_id: string;
  delta_cents: string;
  note: string | null;
}

const notFound = (what: string) => new AppError(404, ErrorCode.NotFound, `${what} não encontrado.`);

/** Every admin action writes its audit row in the same transaction as the change. */
async function audit(c: pg.PoolClient, adminId: string, action: AuditAction, payload: Record<string, unknown>): Promise<void> {
  await c.query('insert into admin_audit (admin_id, action, payload) values ($1, $2, $3)', [adminId, action, JSON.stringify(payload)]);
}

interface AccessRow {
  user_id: string;
  email: string;
  name: string;
  indicator: PremiumIndicator;
  granted_at: string;
  granted_by_email: string | null;
}

const ACCESS_SELECT = `
  select x.user_id, u.email::text as email, u.name, x.indicator, ${isoUs('x.granted_at')} as granted_at,
         g.email::text as granted_by_email
    from indicator_access x
    join users u on u.id = x.user_id
    left join users g on g.id = x.granted_by`;

const toAccess = (r: AccessRow): IndicatorAccessView => ({
  userId: r.user_id,
  email: r.email,
  name: r.name,
  indicator: r.indicator,
  grantedAt: r.granted_at,
  grantedByEmail: r.granted_by_email,
});

async function userById(db: pg.Pool | pg.PoolClient, id: string): Promise<AdminUserView | null> {
  const { rows } = await db.query<UserRow>(`${USER_SELECT} where u.id = $1`, [id]);
  return rows[0] ? toUser(rows[0]) : null;
}

export function createAdminService(deps: AdminServiceDeps): AdminService {
  const { pool } = deps;

  return {
    async listUsers(q) {
      const cursor = decodeCursor(q.cursor);
      if (cursor && !UUID_RE.test(cursor.id)) throw new AppError(400, ErrorCode.ValidationFailed, 'cursor: cursor inválido.');
      const search = q.q ? likePattern(q.q) : null;
      const { rows } = await pool.query<UserRow>(
        `${USER_SELECT}
          where ($1::text is null or u.email::text ilike $1 or u.name ilike $1)
            and ($2::timestamptz is null or (u.created_at, u.id) < ($2::timestamptz, $3::uuid))
          order by u.created_at desc, u.id desc
          limit $4`,
        [search, cursor?.at ?? null, cursor?.id ?? null, q.limit + 1],
      );
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        items: page.map(toUser),
        nextCursor: rows.length > q.limit && last ? encodeCursor({ at: last.created_at, id: last.id }) : null,
      };
    },

    async adjustBalance(adminId, userId, deltaCents, note, idempotencyKey) {
      // Keys are scoped per admin, so two admins cannot collide by picking the same value.
      const storedKey = `admin:${adminId}:${idempotencyKey}`;
      const findPrior = async (db: pg.Pool | pg.PoolClient) =>
        (await db.query<PriorAdjustment>('select id::text, user_id, delta_cents, note from ledger where idempotency_key = $1', [storedKey]))
          .rows[0] ?? null;
      const replay = async (prior: PriorAdjustment): Promise<CreditResult> => {
        if (prior.user_id !== userId || Number(prior.delta_cents) !== deltaCents || prior.note !== note) {
          throw new AppError(409, ErrorCode.IdempotencyConflict, 'Esta Idempotency-Key já foi usada em outro ajuste.');
        }
        const user = await userById(pool, userId);
        if (!user) throw notFound('Usuário');
        return { user, ledgerId: prior.id, replayed: true };
      };

      const early = await findPrior(pool);
      if (early) return replay(early);

      let result: string | PriorAdjustment;
      try {
        result = await inTransaction(pool, async (c): Promise<string | PriorAdjustment> => {
          const acc = await c.query<{ balance_cents: string; email: string }>(
            `select a.balance_cents, u.email::text as email
               from accounts a join users u on u.id = a.user_id
              where a.user_id = $1 and a.kind = 'real'
                for update of a`,
            [userId],
          );
          const row = acc.rows[0];
          if (!row) throw notFound('Usuário');
          // A parallel retry for the same user waited on the row lock: see if it already went through.
          const raced = await findPrior(c);
          if (raced) return raced;
          const before = Number(row.balance_cents);
          const after = before + deltaCents;
          if (after < 0) {
            throw new AppError(400, ErrorCode.InsufficientBalance, 'Débito maior que o saldo disponível. O saldo não pode ficar negativo.');
          }
          await c.query(`update accounts set balance_cents = $2 where user_id = $1 and kind = 'real'`, [userId, after]);
          const kind = deltaCents > 0 ? 'credit' : 'debit';
          const led = await c.query<{ id: string }>(
            `insert into ledger (user_id, delta_cents, balance_after, kind, note, idempotency_key)
             values ($1, $2, $3, $4, $5, $6) returning id::text`,
            [userId, deltaCents, after, kind, note, storedKey],
          );
          const ledgerId = led.rows[0]?.id;
          if (!ledgerId) throw new Error('ledger insert returned no id');
          await audit(c, adminId, kind === 'credit' ? 'user.credit' : 'user.debit', {
            userId,
            email: row.email,
            deltaCents,
            balanceBefore: before,
            balanceAfter: after,
            note,
            ledgerId,
          });
          return ledgerId;
        });
      } catch (err) {
        // Same key used in parallel for a different user: the unique index decides the winner.
        const winner = isUniqueViolation(err) ? await findPrior(pool) : null;
        if (!winner) throw err;
        result = winner;
      }
      if (typeof result !== 'string') return replay(result);
      const user = await userById(pool, userId);
      if (!user) throw notFound('Usuário');
      return { user, ledgerId: result, replayed: false };
    },

    async setBlocked(adminId, userId, blocked) {
      if (blocked && userId === adminId) {
        throw new AppError(400, ErrorCode.BadRequest, 'Você não pode bloquear a própria conta.');
      }
      await inTransaction(pool, async (c) => {
        const cur = await c.query<{ status: string; email: string; role: string }>(
          'select status, email::text as email, role from users where id = $1 for update',
          [userId],
        );
        const row = cur.rows[0];
        if (!row) throw notFound('Usuário');
        const next = blocked ? 'blocked' : 'active';
        if (row.status === next) return;
        await c.query('update users set status = $2 where id = $1', [userId, next]);
        // Blocking ends every session now; the WS gateway drops its sockets on the next revalidation.
        if (blocked) await c.query('delete from sessions where user_id = $1', [userId]);
        await audit(c, adminId, blocked ? 'user.block' : 'user.unblock', { userId, email: row.email, role: row.role });
      });
      const user = await userById(pool, userId);
      if (!user) throw notFound('Usuário');
      return user;
    },

    async listAssets() {
      const { rows } = await pool.query<AssetRowDb>(
        'select id, symbol, display, payout_pct, enabled, sort, kind, category, otc_vol_pct_hour::text, otc_drift_pct_hour::text from assets order by sort, id',
      );
      return rows.map(toAsset);
    },

    async updateAsset(adminId, assetId, patch) {
      const updated = await inTransaction(pool, async (c) => {
        const cur = await c.query<AssetRowDb>(
          'select id, symbol, display, payout_pct, enabled, sort, kind, category, otc_vol_pct_hour::text, otc_drift_pct_hour::text from assets where id = $1 for update',
          [assetId],
        );
        const before = cur.rows[0];
        if (!before) throw notFound('Ativo');
        const payoutPct = patch.payoutPct ?? before.payout_pct;
        const enabled = patch.enabled ?? before.enabled;
        if (patch.otcVolPctHour !== undefined && before.kind !== 'otc') {
          throw new AppError(400, ErrorCode.BadRequest, 'Volatilidade só se aplica a ativos OTC.');
        }
        const beforeVol = before.otc_vol_pct_hour === null ? null : Number(before.otc_vol_pct_hour);
        const vol = patch.otcVolPctHour ?? beforeVol;
        if (payoutPct === before.payout_pct && enabled === before.enabled && vol === beforeVol) return toAsset(before);
        const drift = Math.abs(Number(before.otc_drift_pct_hour));
        if (drift > 0 && vol !== null) {
          // A trend is predictable: keep it small next to the noise (database check) and the payout low enough
          // that always following it on a 30-minute trade still loses (see the OTC generator notes).
          if (drift > OTC_DRIFT_MAX_RATIO * vol) {
            throw new AppError(
              400,
              ErrorCode.BadRequest,
              `Para este índice a volatilidade mínima é ${(drift / OTC_DRIFT_MAX_RATIO).toFixed(1).replace('.', ',')}%/h.`,
            );
          }
          if (payoutPct > OTC_TREND_PAYOUT_MAX) {
            throw new AppError(400, ErrorCode.BadRequest, `Índices com tendência aceitam payout de no máximo ${OTC_TREND_PAYOUT_MAX}%.`);
          }
        }
        const { rows } = await c.query<AssetRowDb>(
          `update assets set payout_pct = $2, enabled = $3, otc_vol_pct_hour = $4 where id = $1
           returning id, symbol, display, payout_pct, enabled, sort, kind, category, otc_vol_pct_hour::text, otc_drift_pct_hour::text`,
          [assetId, payoutPct, enabled, vol],
        );
        const after = rows[0];
        if (!after) throw notFound('Ativo');
        await audit(c, adminId, 'asset.update', {
          assetId,
          symbol: before.symbol,
          before: { payoutPct: before.payout_pct, enabled: before.enabled, ...(beforeVol === null ? {} : { otcVolPctHour: beforeVol }) },
          after: { payoutPct: after.payout_pct, enabled: after.enabled, ...(vol === null ? {} : { otcVolPctHour: vol }) },
        });
        return toAsset(after);
      });
      deps.onAssetsChanged?.();
      return updated;
    },

    async allowedIndicators(userId, role) {
      if (role === 'admin') return [...PREMIUM_INDICATORS];
      const { rows } = await pool.query<{ indicator: PremiumIndicator }>(
        'select indicator from indicator_access where user_id = $1 order by indicator',
        [userId],
      );
      return rows.map((r) => r.indicator);
    },

    async listIndicatorAccess() {
      const { rows } = await pool.query<AccessRow>(`${ACCESS_SELECT} order by x.indicator, x.granted_at desc`);
      return rows.map(toAccess);
    },

    async grantIndicator(adminId, email, indicator) {
      return inTransaction(pool, async (c) => {
        const u = await c.query<{ id: string; email: string }>('select id, email::text as email from users where email = $1', [email]);
        const target = u.rows[0];
        if (!target) throw new AppError(404, ErrorCode.NotFound, 'Nenhum usuário com este e-mail.');
        const ins = await c.query(
          `insert into indicator_access (user_id, indicator, granted_by) values ($1, $2, $3)
           on conflict (user_id, indicator) do nothing`,
          [target.id, indicator, adminId],
        );
        if ((ins.rowCount ?? 0) > 0) await audit(c, adminId, 'indicator.grant', { userId: target.id, email: target.email, indicator });
        const { rows } = await c.query<AccessRow>(`${ACCESS_SELECT} where x.user_id = $1 and x.indicator = $2`, [target.id, indicator]);
        return toAccess(rows[0]!);
      });
    },

    async revokeIndicator(adminId, userId, indicator) {
      await inTransaction(pool, async (c) => {
        const del = await c.query<{ email: string }>(
          `delete from indicator_access x using users u
            where x.user_id = $1 and x.indicator = $2 and u.id = x.user_id
          returning u.email::text as email`,
          [userId, indicator],
        );
        const row = del.rows[0];
        if (!row) throw notFound('Acesso');
        await audit(c, adminId, 'indicator.revoke', { userId, email: row.email, indicator });
      });
    },

    async listAudit(q) {
      const cursor = decodeCursor(q.cursor);
      if (cursor && !/^\d{1,19}$/.test(cursor.id)) throw new AppError(400, ErrorCode.ValidationFailed, 'cursor: cursor inválido.');
      const { rows } = await pool.query<{
        id: string;
        admin_id: string;
        admin_email: string;
        action: string;
        payload: Record<string, unknown>;
        created_at: string;
      }>(
        `select l.id::text, l.admin_id, u.email::text as admin_email, l.action, l.payload, ${isoUs('l.created_at')} as created_at
           from admin_audit l join users u on u.id = l.admin_id
          where ($1::text is null or l.action = $1)
            and ($2::timestamptz is null or (l.created_at, l.id) < ($2::timestamptz, $3::bigint))
          order by l.created_at desc, l.id desc
          limit $4`,
        [q.action ?? null, cursor?.at ?? null, cursor?.id ?? null, q.limit + 1],
      );
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        items: page.map((r) => ({
          id: r.id,
          adminId: r.admin_id,
          adminEmail: r.admin_email,
          action: r.action,
          payload: r.payload,
          createdAt: r.created_at,
        })),
        nextCursor: rows.length > q.limit && last ? encodeCursor({ at: last.created_at, id: last.id }) : null,
      };
    },
  };
}
