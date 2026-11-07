import { createHash, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { parseSessionCookie, SESSION_COOKIE } from '@traderoom/shared';

export interface WsSession {
  sessionId: string;
  userId: string;
}

export interface SessionStore {
  /** Resolves the `sid` cookie; null for missing, forged or expired sessions and blocked users. */
  resolve(cookieHeader: string | undefined): Promise<WsSession | null>;
  /** Of the given session ids, returns those that are still valid. */
  stillValid(sessionIds: readonly string[]): Promise<Set<string>>;
}

/** Reads one cookie from a raw `Cookie` header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Same rules as the API's `resolveSession`, read-only (the API deletes expired rows). */
export function createSessionStore(pool: pg.Pool): SessionStore {
  return {
    async resolve(cookieHeader) {
      const parsed = parseSessionCookie(readCookie(cookieHeader, SESSION_COOKIE));
      if (!parsed) return null;
      const { rows } = await pool.query<{ token_hash: string; user_id: string; ok: boolean }>(
        `select s.token_hash, s.user_id, (s.expires_at > now() and u.status = 'active') as ok
           from sessions s join users u on u.id = s.user_id
          where s.id = $1`,
        [parsed.sessionId],
      );
      const row = rows[0];
      if (!row || !safeEqual(sha256Hex(parsed.token), row.token_hash) || !row.ok) return null;
      return { sessionId: parsed.sessionId, userId: row.user_id };
    },

    async stillValid(sessionIds) {
      if (sessionIds.length === 0) return new Set();
      const { rows } = await pool.query<{ id: string }>(
        `select s.id from sessions s join users u on u.id = s.user_id
          where s.id = any($1::uuid[]) and s.expires_at > now() and u.status = 'active'`,
        [sessionIds],
      );
      return new Set(rows.map((r) => r.id));
    },
  };
}
