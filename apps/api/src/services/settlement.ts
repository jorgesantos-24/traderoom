import type pg from 'pg';
import { creditCents, decideOutcome, type AccountKind, type Direction, type OrderStatus } from '@traderoom/shared';

/** A close price must come from a snapshot taken at most this long before expiry (spec: 3 s). */
export const CLOSE_PRICE_WINDOW_MS = 3000;
/**
 * Wait this long after expiry before settling, so the snapshot taken just before
 * expiry (written every 1 s by the relay) has landed in Postgres.
 */
export const SETTLE_GRACE_MS = 1500;

export type SettleResult =
  | { kind: 'settled'; status: Exclude<OrderStatus, 'open'>; creditCents: number; userId: string; expiresAtMs: number }
  | { kind: 'already_settled' }
  | { kind: 'not_due' }
  | { kind: 'missing' };

export const VOID_NOTES = {
  noPrice: 'Sem cotação no vencimento; valor devolvido.',
  tie: 'Empate; valor devolvido.',
} as const;

/**
 * Settles one order in a single transaction. Locks the order row and requires
 * status = 'open', so running it twice (or in parallel) credits at most once.
 */
export async function settleOrder(pool: pg.Pool, orderId: string, nowMs: number): Promise<SettleResult> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query<{
      user_id: string;
      account: AccountKind;
      asset_id: number;
      direction: Direction;
      stake_cents: string;
      payout_pct: number;
      open_price: string;
      status: OrderStatus;
      opens_at: Date;
      expires_at: Date;
      override_id: string | null;
    }>(
      `select user_id, account, asset_id, direction, stake_cents, payout_pct, open_price::text as open_price, status,
              opens_at, expires_at, override_id::text as override_id
         from orders where id = $1 for update`,
      [orderId],
    );
    const o = rows[0];
    if (!o) {
      await client.query('rollback');
      return { kind: 'missing' };
    }
    if (o.status !== 'open') {
      await client.query('rollback');
      return { kind: 'already_settled' };
    }
    if (o.expires_at.getTime() > nowMs) {
      await client.query('rollback');
      return { kind: 'not_due' };
    }

    // Latest snapshot at or before expiry, no older than the window. An order opened on a natural
    // price settles on the real market price even if an override was showing another one at expiry;
    // only an order opened on the override's price settles on the shown price.
    const closeCol = o.override_id === null ? 'coalesce(real_price, price)' : 'price';
    const snap = await client.query<{ price: string }>(
      `select ${closeCol}::text as price from price_snapshots
        where asset_id = $1 and captured_at <= $2 and captured_at >= $2 - make_interval(secs => $3)
        order by captured_at desc limit 1`,
      [o.asset_id, o.expires_at, CLOSE_PRICE_WINDOW_MS / 1000],
    );
    const closePrice = snap.rows[0]?.price ?? null;
    const status = closePrice === null ? 'void' : decideOutcome(o.direction, o.open_price, closePrice);
    const stake = Number(o.stake_cents);
    const credit = creditCents(status, stake, o.payout_pct);

    await client.query(
      `update orders set status = $2, close_price = $3, settled_at = now() where id = $1 and status = 'open'`,
      [orderId, status, closePrice],
    );

    if (credit > 0) {
      const acc = await client.query<{ balance_cents: string }>(
        'select balance_cents from accounts where user_id = $1 and kind = $2 for update',
        [o.user_id, o.account],
      );
      const balance = Number(acc.rows[0]?.balance_cents ?? NaN);
      if (!Number.isFinite(balance)) throw new Error(`account missing for user ${o.user_id}`);
      const after = balance + credit;
      await client.query('update accounts set balance_cents = $2 where user_id = $1 and kind = $3', [o.user_id, after, o.account]);
      const note = status === 'void' ? (closePrice === null ? VOID_NOTES.noPrice : VOID_NOTES.tie) : null;
      await client.query(
        `insert into ledger (user_id, order_id, delta_cents, balance_after, kind, note, account)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [o.user_id, orderId, credit, after, status === 'won' ? 'payout' : 'refund', note, o.account],
      );
    }
    await client.query('commit');
    return { kind: 'settled', status, creditCents: credit, userId: o.user_id, expiresAtMs: o.expires_at.getTime() };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
