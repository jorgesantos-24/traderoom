import type pg from 'pg';
import {
  ACTIVITY_GROUP_KINDS,
  ErrorCode,
  type AdminActivityQuery,
  type AdminActivityView,
  type AdminResultsResponse,
  type HouseClientResult,
  type HousePeriodResult,
  type Page,
} from '@traderoom/shared';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { AppError } from '../lib/errors.js';
import { HIDDEN_FROM_LOGS } from '../lib/hidden-accounts.js';
import { likePattern } from './admin.js';
import { isoUs } from './orders.js';

/**
 * Admin "Logs" (every balance movement of every client, newest first) and "Resultados"
 * (what the house made or lost against its clients: real accounts only, admins left out).
 */
export interface AdminReportsService {
  activity(q: AdminActivityQuery): Promise<Page<AdminActivityView>>;
  results(tz: string): Promise<AdminResultsResponse>;
}

/** House side of one order, same rounding as settlement: a lost stake is kept, a win pays the floored profit. */
const PROFIT = `(o.stake_cents * o.payout_pct) / 100`;
const HOUSE = `case o.status when 'lost' then o.stake_cents when 'won' then -${PROFIT} else 0 end`;

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface ActivityRow {
  id: string;
  created_at: string;
  user_id: string;
  user_name: string;
  user_email: string;
  account: 'real' | 'demo';
  kind: AdminActivityView['kind'];
  delta_cents: string;
  balance_after: string;
  note: string | null;
  order_id: string | null;
  asset: string | null;
  direction: 'call' | 'put' | null;
  status: 'open' | 'won' | 'lost' | 'void' | null;
  stake_cents: string | null;
  payout_pct: number | null;
  duration_sec: number | null;
}

interface PeriodRow {
  key: 'today' | 'week' | 'month';
  entries: number;
  traders: number;
  volume: string;
  won: number;
  lost: number;
  void: number;
  open: number;
  collected: string;
  paid: string;
  deposits: string;
  deposits_count: number;
  withdrawals: string;
  withdrawals_count: number;
}

interface ClientRow {
  user_id: string;
  name: string;
  email: string;
  entries: number;
  volume: string;
  net: string;
}

const toClient = (r: ClientRow): HouseClientResult => ({
  userId: r.user_id,
  name: r.name,
  email: r.email,
  entries: r.entries,
  volumeCents: Number(r.volume),
  netCents: Number(r.net),
});

/** Period starts in the zone `$1`: today, this week (Monday) and this month. */
const PERIODS = `periods(key, start) as (
  values ('today', date_trunc('day', now() at time zone $1) at time zone $1),
         ('week', date_trunc('week', now() at time zone $1) at time zone $1),
         ('month', date_trunc('month', now() at time zone $1) at time zone $1)
)`;

export function createAdminReportsService(pool: pg.Pool): AdminReportsService {
  return {
    async activity(q) {
      const cursor = decodeCursor(q.cursor);
      if (cursor && !/^\d{1,19}$/.test(cursor.id)) throw new AppError(400, ErrorCode.ValidationFailed, 'cursor: cursor inválido.');
      const kinds = q.group ? [...ACTIVITY_GROUP_KINDS[q.group]] : null;
      const like = q.q ? likePattern(q.q) : null;
      const { rows } = await pool.query<ActivityRow>(
        `select l.id::text, ${isoUs('l.created_at')} as created_at, l.user_id, u.name as user_name, u.email::text as user_email,
                l.account, l.kind, l.delta_cents, l.balance_after, l.note,
                o.id as order_id, a.display as asset, o.direction, o.status, o.stake_cents, o.payout_pct, o.duration_sec
           from ledger l
           join users u on u.id = l.user_id
           left join orders o on o.id = l.order_id
           left join assets a on a.id = o.asset_id
          where ($1::text[] is null or l.kind = any($1))
            and ($2::text = 'all' or l.account = $2)
            and ($3::text is null or u.email ilike $3 or u.name ilike $3)
            and ($4::timestamptz is null or (l.created_at, l.id) < ($4::timestamptz, $5::bigint))
            and lower(u.email::text) <> all($7::text[])
            -- Credits/debits a hidden admin made on someone else's account (key: admin:<adminId>:<key>).
            and not exists (
              select 1 from users h
               where lower(h.email::text) = any($7::text[])
                 and l.idempotency_key like 'admin:' || h.id::text || ':%'
            )
          order by l.created_at desc, l.id desc
          limit $6`,
        [kinds, q.account, like, cursor?.at ?? null, cursor?.id ?? null, q.limit + 1, HIDDEN_FROM_LOGS],
      );
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        items: page.map(
          (r): AdminActivityView => ({
            id: r.id,
            createdAt: r.created_at,
            userId: r.user_id,
            userName: r.user_name,
            userEmail: r.user_email,
            account: r.account,
            kind: r.kind,
            deltaCents: Number(r.delta_cents),
            balanceAfterCents: Number(r.balance_after),
            note: r.note,
            order:
              r.order_id && r.direction && r.status
                ? {
                    id: r.order_id,
                    asset: r.asset ?? '',
                    direction: r.direction,
                    status: r.status,
                    stakeCents: Number(r.stake_cents),
                    payoutPct: r.payout_pct ?? 0,
                    durationSec: r.duration_sec ?? 0,
                  }
                : null,
          }),
        ),
        nextCursor: rows.length > q.limit && last ? encodeCursor({ at: last.created_at, id: last.id }) : null,
      };
    },

    async results(tz) {
      if (!validZone(tz)) throw new AppError(400, ErrorCode.ValidationFailed, 'tz: fuso horário inválido.');
      // Real money only, and admins' own test orders stay out of the house numbers.
      const clientOrders = `orders o join users u on u.id = o.user_id and u.role = 'user'`;
      const [periods, open, daily, winners, losers] = await Promise.all([
        pool.query<PeriodRow>(
          `with ${PERIODS}
           select p.key,
                  coalesce(t.entries, 0)::int as entries, coalesce(t.traders, 0)::int as traders,
                  coalesce(t.volume, 0)::text as volume, coalesce(t.won, 0)::int as won, coalesce(t.lost, 0)::int as lost,
                  coalesce(t.void, 0)::int as void, coalesce(t.open, 0)::int as open,
                  coalesce(t.collected, 0)::text as collected, coalesce(t.paid, 0)::text as paid,
                  coalesce(d.total, 0)::text as deposits, coalesce(d.n, 0)::int as deposits_count,
                  coalesce(w.total, 0)::text as withdrawals, coalesce(w.n, 0)::int as withdrawals_count
             from periods p
             left join lateral (
               select count(*) as entries, count(distinct o.user_id) as traders, sum(o.stake_cents) as volume,
                      count(*) filter (where o.status = 'won') as won, count(*) filter (where o.status = 'lost') as lost,
                      count(*) filter (where o.status = 'void') as void, count(*) filter (where o.status = 'open') as open,
                      sum(o.stake_cents) filter (where o.status = 'lost') as collected,
                      sum(${PROFIT}) filter (where o.status = 'won') as paid
                 from ${clientOrders}
                where o.account = 'real' and o.opens_at >= p.start
             ) t on true
             left join lateral (
               select sum(x.credited_cents) as total, count(*) as n
                 from deposits x join users u on u.id = x.user_id and u.role = 'user'
                where x.status = 'paid' and x.paid_at >= p.start
             ) d on true
             left join lateral (
               select sum(x.amount_cents) as total, count(*) as n
                 from withdrawals x join users u on u.id = x.user_id and u.role = 'user'
                where x.status = 'completed' and x.completed_at >= p.start
             ) w on true`,
          [tz],
        ),
        pool.query<{ orders: number; stake: string; max_payout: string }>(
          `select count(*)::int as orders, coalesce(sum(o.stake_cents), 0)::text as stake, coalesce(sum(${PROFIT}), 0)::text as max_payout
             from ${clientOrders}
            where o.account = 'real' and o.status = 'open'`,
        ),
        pool.query<{ day: string; entries: number; volume: string; house: string }>(
          `with days as (
             select generate_series(date_trunc('day', now() at time zone $1) - interval '29 days',
                                    date_trunc('day', now() at time zone $1), interval '1 day') as d
           )
           select to_char(days.d, 'YYYY-MM-DD') as day, count(o.id)::int as entries,
                  coalesce(sum(o.stake_cents), 0)::text as volume, coalesce(sum(${HOUSE}), 0)::text as house
             from days
             left join (${clientOrders}) on o.account = 'real'
                  and o.opens_at >= days.d at time zone $1 and o.opens_at < (days.d + interval '1 day') at time zone $1
            group by days.d
            order by days.d`,
          [tz],
        ),
        ...(['desc', 'asc'] as const).map((dir) =>
          pool.query<ClientRow>(
            `select o.user_id, u.name, u.email::text as email, count(*)::int as entries,
                    sum(o.stake_cents)::text as volume, sum(-(${HOUSE}))::text as net
               from ${clientOrders}
              where o.account = 'real' and o.status <> 'open'
                and o.opens_at >= date_trunc('month', now() at time zone $1) at time zone $1
              group by o.user_id, u.name, u.email
             having sum(-(${HOUSE})) ${dir === 'desc' ? '> 0' : '< 0'}
              order by sum(-(${HOUSE})) ${dir}
              limit 10`,
            [tz],
          ),
        ),
      ]);

      const period = (key: PeriodRow['key']): HousePeriodResult => {
        const r = periods.rows.find((p) => p.key === key);
        const collected = Number(r?.collected ?? 0);
        const paid = Number(r?.paid ?? 0);
        return {
          entries: r?.entries ?? 0,
          traders: r?.traders ?? 0,
          volumeCents: Number(r?.volume ?? 0),
          won: r?.won ?? 0,
          lost: r?.lost ?? 0,
          void: r?.void ?? 0,
          open: r?.open ?? 0,
          collectedCents: collected,
          paidCents: paid,
          houseCents: collected - paid,
          depositsCents: Number(r?.deposits ?? 0),
          depositsCount: r?.deposits_count ?? 0,
          withdrawalsCents: Number(r?.withdrawals ?? 0),
          withdrawalsCount: r?.withdrawals_count ?? 0,
        };
      };
      const o = open.rows[0];
      return {
        tz,
        generatedAt: new Date().toISOString(),
        today: period('today'),
        week: period('week'),
        month: period('month'),
        openNow: { orders: o?.orders ?? 0, stakeCents: Number(o?.stake ?? 0), maxPayoutCents: Number(o?.max_payout ?? 0) },
        daily: daily.rows.map((r) => ({ day: r.day, entries: r.entries, volumeCents: Number(r.volume), houseCents: Number(r.house) })),
        topWinners: (winners?.rows ?? []).map(toClient),
        topLosers: (losers?.rows ?? []).map(toClient),
      };
    },
  };
}
