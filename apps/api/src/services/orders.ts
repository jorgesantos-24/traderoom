import type pg from 'pg';
import {
  creditCents,
  ErrorCode,
  FEED_STALE_MS,
  isPriceStale,
  parsePriceRecord,
  RedisKeys,
  type AccountKind,
  type CreateOrderInput,
  type Direction,
  type ListOrdersQuery,
  type OrderStatus,
  type OrderView,
  type Page,
} from '@traderoom/shared';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { AppError } from '../lib/errors.js';
import type { AssetRepo } from './assets.js';
import type { OrderLimitsRepo } from './order-limits.js';

/** ISO-8601 with microseconds, so keyset cursors round-trip exactly. */
export const isoUs = (col: string): string => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface OrderRow {
  id: string;
  user_id: string;
  account: AccountKind;
  asset_id: number;
  symbol: string;
  direction: Direction;
  stake_cents: string;
  payout_pct: number;
  duration_sec: number;
  open_price: string;
  close_price: string | null;
  status: OrderStatus;
  opens_at: string;
  expires_at: string;
  settled_at: string | null;
}

export const ORDER_COLUMNS = `o.id, o.user_id, o.account, o.asset_id, a.symbol, o.direction, o.stake_cents, o.payout_pct, o.duration_sec,
  o.open_price::text as open_price, o.close_price::text as close_price, o.status,
  ${isoUs('o.opens_at')} as opens_at, ${isoUs('o.expires_at')} as expires_at, ${isoUs('o.settled_at')} as settled_at`;

export function toOrderView(r: OrderRow): OrderView {
  const stake = Number(r.stake_cents);
  return {
    id: r.id,
    account: r.account,
    assetId: r.asset_id,
    symbol: r.symbol,
    direction: r.direction,
    stakeCents: stake,
    payoutPct: r.payout_pct,
    durationSec: r.duration_sec,
    openPrice: r.open_price,
    closePrice: r.close_price,
    status: r.status,
    payoutCents: r.status === 'open' ? 0 : creditCents(r.status, stake, r.payout_pct),
    potentialPayoutCents: creditCents('won', stake, r.payout_pct),
    opensAt: r.opens_at,
    expiresAt: r.expires_at,
    settledAt: r.settled_at,
  };
}

export interface PriceReader {
  /** Raw `px:<symbol>` value. */
  get(symbol: string): Promise<string | null>;
}

export interface DueScheduler {
  /** Adds the order to `orders:due` with score = expires_at ms. */
  schedule(orderId: string, expiresAtMs: number): Promise<void>;
}

export interface CreateOrderResult {
  order: OrderView;
  /** True when an earlier request with the same Idempotency-Key already created it. */
  replayed: boolean;
}

export interface OrderService {
  create(userId: string, input: CreateOrderInput, idempotencyKey: string): Promise<CreateOrderResult>;
  list(userId: string, q: ListOrdersQuery): Promise<Page<OrderView>>;
}

export interface OrderServiceDeps {
  pool: pg.Pool;
  prices: PriceReader;
  scheduler: DueScheduler;
  assets: AssetRepo;
  limits: OrderLimitsRepo;
  staleMs?: number;
  /**
   * Anti latency-arbitrage: the entry price is the first one our feed received at least this long
   * after the order arrived, never the price already on screen. A bot with a faster Binance feed
   * that sees a move before we do can't lock in the old price. 0 = take the current price.
   */
  entryDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called when scheduling fails after commit; the worker's sweep picks the order up anyway. */
  onScheduleError?: (err: unknown, orderId: string) => void;
}

const sameRequest = (o: OrderView, i: CreateOrderInput): boolean =>
  o.account === i.account && o.assetId === i.assetId && o.direction === i.direction && o.stakeCents === i.stakeCents && o.durationSec === i.durationSec;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

/** How often to re-read the price while waiting for the entry price. */
const ENTRY_POLL_MS = 50;

export function createOrderService(deps: OrderServiceDeps): OrderService {
  const now = deps.now ?? Date.now;
  const staleMs = deps.staleMs ?? FEED_STALE_MS;
  const entryDelayMs = deps.entryDelayMs ?? 0;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /**
   * The order's entry price: the newest price received at or after `arrivedAt + entryDelayMs`.
   * Waits for it at most `staleMs` past that point (quiet assets refresh every second).
   */
  async function entryPrice(symbol: string, arrivedAt: number) {
    const notBefore = arrivedAt + entryDelayMs;
    if (entryDelayMs > 0) await sleep(Math.max(0, notBefore - now()));
    const polls = entryDelayMs > 0 ? Math.ceil(staleMs / ENTRY_POLL_MS) : 0;
    for (let i = 0; ; i++) {
      const price = parsePriceRecord(await deps.prices.get(symbol));
      const t = now();
      const fresh = price !== null && !isPriceStale(price, t, staleMs);
      if (fresh && (entryDelayMs === 0 || price.rt >= notBefore)) return { price, at: t };
      if (i >= polls) return null;
      await sleep(ENTRY_POLL_MS);
    }
  }

  async function findByKey(db: pg.Pool | pg.PoolClient, storedKey: string): Promise<OrderView | null> {
    const { rows } = await db.query<OrderRow>(
      `select ${ORDER_COLUMNS} from orders o join assets a on a.id = o.asset_id where o.idempotency_key = $1`,
      [storedKey],
    );
    return rows[0] ? toOrderView(rows[0]) : null;
  }

  function replay(existing: OrderView, input: CreateOrderInput): CreateOrderResult {
    if (!sameRequest(existing, input)) {
      throw new AppError(409, ErrorCode.IdempotencyConflict, 'Esta Idempotency-Key já foi usada em outra ordem.');
    }
    return { order: existing, replayed: true };
  }

  return {
    async create(userId, input, idempotencyKey) {
      // Keys are per user: two users may pick the same value without colliding on the unique index.
      const storedKey = `${userId}:${idempotencyKey}`;
      // A retry must get the original answer even if the price or balance changed since.
      const prior = await findByKey(deps.pool, storedKey);
      if (prior) return replay(prior, input);

      const limits = await deps.limits.get();
      if (!limits.durationsSec.includes(input.durationSec)) {
        throw new AppError(
          400,
          ErrorCode.ValidationFailed,
          `durationSec: duração não permitida. Use: ${limits.durationsSec.join(', ')} s.`,
        );
      }
      if (input.stakeCents < limits.minStakeCents || input.stakeCents > limits.maxStakeCents) {
        const fmt = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        throw new AppError(
          400,
          ErrorCode.ValidationFailed,
          `stakeCents: o valor deve estar entre ${fmt(limits.minStakeCents)} e ${fmt(limits.maxStakeCents)}.`,
        );
      }
      const asset = (await deps.assets.enabled()).byId.get(input.assetId);
      if (!asset) throw new AppError(404, ErrorCode.UnknownAsset, 'Ativo não encontrado.');

      const entry = await entryPrice(asset.symbol, now());
      if (!entry) {
        throw new AppError(409, ErrorCode.AssetStale, 'Cotação defasada para este ativo. Tente novamente em instantes.');
      }
      const { price, at: openedAt } = entry;
      const expiresAt = openedAt + input.durationSec * 1000;

      const client = await deps.pool.connect();
      let created: OrderView;
      try {
        await client.query('begin');
        const acc = await client.query<{ balance_cents: string }>(
          'select balance_cents from accounts where user_id = $1 and kind = $2 for update',
          [userId, input.account],
        );
        const balance = acc.rows[0] ? Number(acc.rows[0].balance_cents) : null;
        if (balance === null) throw new Error(`account missing for user ${userId}`);

        // Same key racing in parallel: the account lock serialized us, so re-check under it.
        const raced = await findByKey(client, storedKey);
        if (raced) {
          await client.query('rollback');
          return replay(raced, input);
        }
        if (balance < input.stakeCents) {
          throw new AppError(400, ErrorCode.InsufficientBalance, 'Saldo insuficiente.');
        }

        const ins = await client.query<{ id: string }>(
          `insert into orders (user_id, asset_id, direction, stake_cents, payout_pct, duration_sec,
                               open_price, opens_at, expires_at, idempotency_key, account)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           returning id`,
          [
            userId,
            asset.id,
            input.direction,
            input.stakeCents,
            asset.payoutPct,
            input.durationSec,
            price.p,
            new Date(openedAt),
            new Date(expiresAt),
            storedKey,
            input.account,
          ],
        );
        const orderId = ins.rows[0]?.id;
        if (!orderId) throw new Error('order insert returned no id');
        const newBalance = balance - input.stakeCents;
        await client.query('update accounts set balance_cents = $2 where user_id = $1 and kind = $3', [
          userId,
          newBalance,
          input.account,
        ]);
        await client.query(
          `insert into ledger (user_id, order_id, delta_cents, balance_after, kind, account) values ($1, $2, $3, $4, 'stake', $5)`,
          [userId, orderId, -input.stakeCents, newBalance, input.account],
        );
        const view = await findByKey(client, storedKey);
        if (!view) throw new Error('order vanished inside its own transaction');
        await client.query('commit');
        created = view;
      } catch (err) {
        await client.query('rollback').catch(() => {});
        if (isUniqueViolation(err)) {
          const winner = await findByKey(deps.pool, storedKey);
          if (winner) return replay(winner, input);
        }
        throw err;
      } finally {
        client.release();
      }

      try {
        await deps.scheduler.schedule(created.id, expiresAt);
      } catch (err) {
        deps.onScheduleError?.(err, created.id);
      }
      return { order: created, replayed: false };
    },

    async list(userId, q) {
      const cursor = decodeCursor(q.cursor);
      if (cursor && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cursor.id)) {
        throw new AppError(400, ErrorCode.ValidationFailed, 'cursor: cursor inválido.');
      }
      const { rows } = await deps.pool.query<OrderRow & { cursor_at: string }>(
        `select ${ORDER_COLUMNS}, ${isoUs('o.opens_at')} as cursor_at
           from orders o join assets a on a.id = o.asset_id
          where o.user_id = $1 and o.account = $6
            and ($2::text is null or o.status = $2)
            and ($3::timestamptz is null or (o.opens_at, o.id) < ($3::timestamptz, $4::uuid))
          order by o.opens_at desc, o.id desc
          limit $5`,
        [userId, q.status ?? null, cursor?.at ?? null, cursor?.id ?? null, q.limit + 1, q.account],
      );
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        items: page.map(toOrderView),
        nextCursor: rows.length > q.limit && last ? encodeCursor({ at: last.cursor_at, id: last.id }) : null,
      };
    },
  };
}

export function redisPriceReader(redis: { get(key: string): Promise<string | null> }): PriceReader {
  return { get: (symbol) => redis.get(RedisKeys.price(symbol)) };
}

export function redisDueScheduler(
  redis: { zadd(key: string, score: number, member: string): Promise<unknown> },
  key: string = RedisKeys.ordersDue,
): DueScheduler {
  return {
    async schedule(orderId, expiresAtMs) {
      await redis.zadd(key, expiresAtMs, orderId);
    },
  };
}
