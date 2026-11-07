import type pg from 'pg';
import {
  ACCOUNT_KINDS,
  DEMO_START_CENTS,
  ErrorCode,
  type AccountKind,
  type LedgerEntryView,
  type LedgerKind,
  type ListLedgerQuery,
  type Page,
  type WalletView,
} from '@traderoom/shared';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { inTransaction } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { isoUs } from './orders.js';

export const DEMO_REFILL_NOTE = 'Conta demo recarregada.';

export interface WalletService {
  get(userId: string, account: AccountKind): Promise<WalletView>;
  /** Both accounts, real first. */
  all(userId: string): Promise<WalletView[]>;
  /** Tops the demo balance back up to DEMO_START_CENTS; a no-op when it is already there or above. */
  refillDemo(userId: string): Promise<WalletView>;
  ledger(userId: string, q: ListLedgerQuery): Promise<Page<LedgerEntryView>>;
}

interface WalletRow {
  kind: AccountKind;
  balance_cents: string;
  currency: string;
  open_stake: string;
  open_orders: string;
}

const toView = (r: WalletRow): WalletView => ({
  account: r.kind,
  balanceCents: Number(r.balance_cents),
  currency: r.currency,
  openStakeCents: Number(r.open_stake),
  openOrders: Number(r.open_orders),
});

export function createWalletService(pool: pg.Pool): WalletService {
  async function load(userId: string): Promise<WalletView[]> {
    const { rows } = await pool.query<WalletRow>(
      `select a.kind, a.balance_cents, a.currency,
              coalesce(sum(o.stake_cents), 0) as open_stake, count(o.id) as open_orders
         from accounts a
         left join orders o on o.user_id = a.user_id and o.account = a.kind and o.status = 'open'
        where a.user_id = $1
        group by a.user_id, a.kind`,
      [userId],
    );
    return rows.map(toView).sort((a, b) => ACCOUNT_KINDS.indexOf(a.account) - ACCOUNT_KINDS.indexOf(b.account));
  }

  async function get(userId: string, account: AccountKind): Promise<WalletView> {
    const w = (await load(userId)).find((v) => v.account === account);
    if (!w) throw new Error(`${account} account missing for user ${userId}`);
    return w;
  }

  return {
    get,
    all: load,

    async refillDemo(userId) {
      await inTransaction(pool, async (c) => {
        const { rows } = await c.query<{ balance_cents: string }>(
          `select balance_cents from accounts where user_id = $1 and kind = 'demo' for update`,
          [userId],
        );
        const row = rows[0];
        if (!row) throw new AppError(404, ErrorCode.NotFound, 'Conta demo não encontrada.');
        const before = Number(row.balance_cents);
        if (before >= DEMO_START_CENTS) return;
        await c.query(`update accounts set balance_cents = $2 where user_id = $1 and kind = 'demo'`, [userId, DEMO_START_CENTS]);
        await c.query(
          `insert into ledger (user_id, delta_cents, balance_after, kind, note, account) values ($1, $2, $3, 'adjust', $4, 'demo')`,
          [userId, DEMO_START_CENTS - before, DEMO_START_CENTS, DEMO_REFILL_NOTE],
        );
      });
      return get(userId, 'demo');
    },

    async ledger(userId, q) {
      const cursor = decodeCursor(q.cursor);
      if (cursor && !/^\d{1,19}$/.test(cursor.id)) {
        throw new AppError(400, ErrorCode.ValidationFailed, 'cursor: cursor inválido.');
      }
      const { rows } = await pool.query<{
        id: string;
        kind: LedgerKind;
        delta_cents: string;
        balance_after: string;
        order_id: string | null;
        note: string | null;
        created_at: string;
      }>(
        `select id::text, kind, delta_cents, balance_after, order_id, note, ${isoUs('created_at')} as created_at
           from ledger
          where user_id = $1 and account = $5
            and ($2::timestamptz is null or (created_at, id) < ($2::timestamptz, $3::bigint))
          order by created_at desc, id desc
          limit $4`,
        [userId, cursor?.at ?? null, cursor?.id ?? null, q.limit + 1, q.account],
      );
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        items: page.map((r) => ({
          id: r.id,
          kind: r.kind,
          deltaCents: Number(r.delta_cents),
          balanceAfterCents: Number(r.balance_after),
          orderId: r.order_id,
          note: r.note,
          createdAt: r.created_at,
        })),
        nextCursor: rows.length > q.limit && last ? encodeCursor({ at: last.created_at, id: last.id }) : null,
      };
    },
  };
}
