import type pg from 'pg';
import { z } from 'zod';
import { MAX_STAKE_CENTS_HARD } from '@traderoom/shared';

export interface OrderLimits {
  minStakeCents: number;
  maxStakeCents: number;
  durationsSec: readonly number[];
}

/** Used when a key is missing from `config`; same values as the seed migration. */
export const DEFAULT_ORDER_LIMITS: OrderLimits = { minStakeCents: 100, maxStakeCents: 1_000_000, durationsSec: [60, 300] };

const cents = z.number().int().positive().max(MAX_STAKE_CENTS_HARD);
const durations = z.array(z.number().int().min(5).max(86_400)).min(1);

export interface OrderLimitsRepo {
  get(): Promise<OrderLimits>;
}

/** Reads `orders.*` keys from the config table, cached for `ttlMs`. Malformed values fall back to defaults. */
export function createOrderLimitsRepo(pool: pg.Pool, opts: { ttlMs?: number; now?: () => number } = {}): OrderLimitsRepo {
  const ttlMs = opts.ttlMs ?? 10_000;
  const now = opts.now ?? Date.now;
  let cached: { at: number; value: OrderLimits } | null = null;

  return {
    async get() {
      if (cached && now() - cached.at < ttlMs) return cached.value;
      const { rows } = await pool.query<{ key: string; value: unknown }>(
        `select key, value from config where key in ('orders.min_stake_cents', 'orders.max_stake_cents', 'orders.durations_sec')`,
      );
      const map = new Map(rows.map((r) => [r.key, r.value]));
      const min = cents.safeParse(map.get('orders.min_stake_cents'));
      const max = cents.safeParse(map.get('orders.max_stake_cents'));
      const dur = durations.safeParse(map.get('orders.durations_sec'));
      let value: OrderLimits = {
        minStakeCents: min.success ? min.data : DEFAULT_ORDER_LIMITS.minStakeCents,
        maxStakeCents: max.success ? max.data : DEFAULT_ORDER_LIMITS.maxStakeCents,
        durationsSec: dur.success ? [...new Set(dur.data)].sort((a, b) => a - b) : DEFAULT_ORDER_LIMITS.durationsSec,
      };
      if (value.minStakeCents > value.maxStakeCents) value = { ...value, ...DEFAULT_ORDER_LIMITS, durationsSec: value.durationsSec };
      cached = { at: now(), value };
      return value;
    },
  };
}
