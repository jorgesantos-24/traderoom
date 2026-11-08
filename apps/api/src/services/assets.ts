import type pg from 'pg';
import type { AssetCategory, AssetKind } from '@traderoom/shared';

export interface AssetRow {
  id: number;
  symbol: string;
  display: string;
  payoutPct: number;
  kind: AssetKind;
  category: AssetCategory;
}

export interface EnabledAssets {
  bySymbol: ReadonlyMap<string, AssetRow>;
  byId: ReadonlyMap<number, AssetRow>;
}

export interface AssetRepo {
  /** Enabled assets. Cached briefly; admin changes show up within the TTL. */
  enabled(): Promise<EnabledAssets>;
  /** Symbols of enabled assets (same cache). */
  enabledSymbols(): Promise<ReadonlySet<string>>;
  /** Drops the cache so the next read hits the database (after an admin change). */
  invalidate(): void;
}

export function createAssetRepo(pool: pg.Pool, opts: { ttlMs?: number; now?: () => number } = {}): AssetRepo {
  const ttlMs = opts.ttlMs ?? 10_000;
  const now = opts.now ?? Date.now;
  interface Snapshot {
    at: number;
    value: EnabledAssets;
    symbols: ReadonlySet<string>;
  }
  let cached: Snapshot | null = null;
  let inFlight: Promise<Snapshot> | null = null;

  async function load(): Promise<Snapshot> {
    if (cached && now() - cached.at < ttlMs) return cached;
    inFlight ??= pool
      .query<{ id: number; symbol: string; display: string; payout_pct: number; kind: AssetKind; category: AssetCategory }>(
        'select id, symbol, display, payout_pct, kind, category from assets where enabled order by sort, id',
      )
      .then(({ rows }) => {
        const list = rows.map((r) => ({
          id: r.id,
          symbol: r.symbol,
          display: r.display,
          payoutPct: r.payout_pct,
          kind: r.kind,
          category: r.category,
        }));
        const value: EnabledAssets = {
          bySymbol: new Map(list.map((a) => [a.symbol, a])),
          byId: new Map(list.map((a) => [a.id, a])),
        };
        const snap: Snapshot = { at: now(), value, symbols: new Set(list.map((a) => a.symbol)) };
        cached = snap;
        return snap;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    enabled: async () => (await load()).value,
    enabledSymbols: async () => (await load()).symbols,
    invalidate() {
      cached = null;
    },
  };
}
