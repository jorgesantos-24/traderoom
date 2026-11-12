import type pg from 'pg';
import type { AdminOnlineResponse, AdminOnlineUserView, UserRole, WsPresenceSnapshot } from '@traderoom/shared';

export interface PresenceService {
  /** Users connected to the price server right now, most recently connected first. */
  listOnline(): Promise<AdminOnlineResponse>;
}

export interface PresenceServiceDeps {
  pool: pg.Pool;
  /** Raw `RedisKeys.wsPresence` value (JSON `WsPresenceSnapshot`), or null when missing. */
  readSnapshot: () => Promise<string | null>;
}

interface Row {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  balance_cents: string;
}

function parseSnapshot(raw: string | null): WsPresenceSnapshot | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as WsPresenceSnapshot;
    return typeof v?.at === 'number' && Array.isArray(v.users) ? v : null;
  } catch {
    return null;
  }
}

export function createPresenceService(deps: PresenceServiceDeps): PresenceService {
  return {
    async listOnline() {
      const snapshot = parseSnapshot(await deps.readSnapshot());
      if (!snapshot) return { users: [], updatedAt: null };
      const ids = snapshot.users.map((u) => u.userId);
      const byId = new Map<string, Row>();
      if (ids.length > 0) {
        const { rows } = await deps.pool.query<Row>(
          `select u.id, u.email::text as email, u.name, u.role, coalesce(a.balance_cents, 0) as balance_cents
             from users u
             left join accounts a on a.user_id = u.id and a.kind = 'real'
            where u.id = any($1::uuid[])`,
          [ids],
        );
        for (const r of rows) byId.set(r.id, r);
      }
      const users: AdminOnlineUserView[] = [];
      for (const p of snapshot.users) {
        const r = byId.get(p.userId);
        if (!r) continue;
        users.push({
          id: r.id,
          email: r.email,
          name: r.name,
          role: r.role,
          balanceCents: Number(r.balance_cents),
          connections: p.connections,
          onlineSince: new Date(p.since).toISOString(),
          assets: p.assets,
        });
      }
      users.sort((a, b) => b.onlineSince.localeCompare(a.onlineSince));
      return { users, updatedAt: new Date(snapshot.at).toISOString() };
    },
  };
}
