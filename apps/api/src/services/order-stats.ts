import type pg from 'pg';
import { ErrorCode, type ListOrderHistoryQuery, type OrderStats, type OrderStatsQuery, type OrderView, type Page } from '@traderoom/shared';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { AppError } from '../lib/errors.js';
import { isoUs, ORDER_COLUMNS, toOrderView, type OrderRow } from './orders.js';

/**
 * "Análises de operações": totals, best/worst order, stake range and a daily P/L series over
 * the settled orders a user opened in a period. Open orders are left out until they settle.
 */
export interface OrderStatsService {
  stats(userId: string, q: OrderStatsQuery): Promise<OrderStats>;
  history(userId: string, q: ListOrderHistoryQuery): Promise<Page<OrderView>>;
}

/** Net result of one settled order, same rule as the settlement credit (profit floors to the cent). */
const NET = `case o.status when 'won' then (o.stake_cents * o.payout_pct) / 100 when 'lost' then -o.stake_cents else 0 end`;

/** Shared filter: $1 user, $2 account, $3 result ('all' or a status), $4 from, $5 to. */
const SETTLED_IN_RANGE = `o.user_id = $1 and o.account = $2 and o.status <> 'open'
  and ($3::text = 'all' or o.status = $3) and o.opens_at >= $4::timestamptz and o.opens_at < $5::timestamptz`;

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

export function createOrderStatsService(pool: pg.Pool): OrderStatsService {
  return {
    async stats(userId, q) {
      if (!validZone(q.tz)) throw new AppError(400, ErrorCode.ValidationFailed, 'tz: fuso horário inválido.');
      const params = [userId, q.account, q.result, q.from, q.to];
      const [totals, daily] = await Promise.all([
        pool.query<{
          total: number;
          won: number;
          lost: number;
          void: number;
          profit: string;
          best: string | null;
          worst: string | null;
          volume: string;
          max_stake: string | null;
          min_stake: string | null;
        }>(
          `select count(*)::int as total,
                  count(*) filter (where o.status = 'won')::int as won,
                  count(*) filter (where o.status = 'lost')::int as lost,
                  count(*) filter (where o.status = 'void')::int as void,
                  coalesce(sum(${NET}), 0)::text as profit,
                  max(${NET})::text as best, min(${NET})::text as worst,
                  coalesce(sum(o.stake_cents), 0)::text as volume,
                  max(o.stake_cents)::text as max_stake, min(o.stake_cents)::text as min_stake
             from orders o
            where ${SETTLED_IN_RANGE}`,
          params,
        ),
        pool.query<{ day: string; net: string; n: number }>(
          `select to_char(o.opens_at at time zone $6, 'YYYY-MM-DD') as day, sum(${NET})::text as net, count(*)::int as n
             from orders o
            where ${SETTLED_IN_RANGE}
            group by 1 order by 1`,
          [...params, q.tz],
        ),
      ]);
      const t = totals.rows[0]!;
      let running = 0;
      const decided = t.won + t.lost;
      return {
        total: t.total,
        won: t.won,
        lost: t.lost,
        void: t.void,
        profitCents: Number(t.profit),
        bestCents: num(t.best),
        worstCents: num(t.worst),
        winRatePct: decided === 0 ? null : Math.round((t.won / decided) * 1000) / 10,
        volumeCents: Number(t.volume),
        maxStakeCents: num(t.max_stake),
        minStakeCents: num(t.min_stake),
        daily: daily.rows.map((d) => {
          running += Number(d.net);
          return { day: d.day, netCents: Number(d.net), cumulativeCents: running, orders: d.n };
        }),
      };
    },

    async history(userId, q) {
      const cursor = decodeCursor(q.cursor);
      if (cursor && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cursor.id)) {
        throw new AppError(400, ErrorCode.ValidationFailed, 'cursor: cursor inválido.');
      }
      const { rows } = await pool.query<OrderRow & { cursor_at: string }>(
        `select ${ORDER_COLUMNS}, ${isoUs('o.opens_at')} as cursor_at
           from orders o join assets a on a.id = o.asset_id
          where ${SETTLED_IN_RANGE}
            and ($6::timestamptz is null or (o.opens_at, o.id) < ($6::timestamptz, $7::uuid))
          order by o.opens_at desc, o.id desc
          limit $8`,
        [userId, q.account, q.result, q.from, q.to, cursor?.at ?? null, cursor?.id ?? null, q.limit + 1],
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
