import type pg from 'pg';
import {
  DEMO_START_CENTS,
  ErrorCode,
  type LoginInput,
  type PublicUser,
  type RegisterInput,
  type ResetInput,
  type UserRole,
} from '@traderoom/shared';
import { inTransaction } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { hashPassword, verifyDummy, verifyPassword } from '../lib/password.js';
import { encodeSessionCookie, generateToken, parseSessionCookie, safeEqual, sha256Hex } from '../lib/tokens.js';

export const SESSION_TTL_SEC = 7 * 24 * 60 * 60;
export const RESET_TTL_SEC = 30 * 60;

export interface SessionInfo {
  sessionId: string;
  user: PublicUser;
}

export interface LoginResult {
  user: PublicUser;
  cookieValue: string;
}

export interface AuthService {
  register(input: RegisterInput): Promise<PublicUser>;
  login(input: LoginInput): Promise<LoginResult>;
  /** Returns null for a missing, malformed, expired or forged session, or a blocked user. */
  resolveSession(cookieValue: string | undefined): Promise<SessionInfo | null>;
  logout(cookieValue: string | undefined): Promise<void>;
  /** Returns the raw token to e-mail, or null when there is no active user with that e-mail. */
  requestPasswordReset(email: string): Promise<{ email: string; token: string } | null>;
  resetPassword(input: ResetInput): Promise<void>;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: 'active' | 'blocked';
}

function toPublic(row: UserRow): PublicUser {
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505' &&
    (err as { constraint?: unknown }).constraint === constraint
  );
}

export function createAuthService(pool: pg.Pool): AuthService {
  return {
    async register({ email, password, name }) {
      const passwordHash = await hashPassword(password);
      try {
        return await inTransaction(pool, async (client) => {
          const { rows } = await client.query<UserRow>(
            `insert into users (email, password_hash, name) values ($1, $2, $3)
             returning id, email, name, role, status`,
            [email, passwordHash, name],
          );
          const user = rows[0]!;
          await client.query(
            `insert into accounts (user_id, kind, balance_cents) values ($1, 'real', 0), ($1, 'demo', $2)`,
            [user.id, DEMO_START_CENTS],
          );
          return toPublic(user);
        });
      } catch (err) {
        if (isUniqueViolation(err, 'users_email_key')) {
          throw new AppError(409, ErrorCode.EmailTaken, 'Este e-mail já está cadastrado.');
        }
        throw err;
      }
    },

    async login({ email, password }) {
      const { rows } = await pool.query<UserRow & { password_hash: string }>(
        'select id, email, name, role, status, password_hash from users where email = $1',
        [email],
      );
      const row = rows[0];
      const ok = row ? await verifyPassword(row.password_hash, password) : await verifyDummy(password);
      if (!row || !ok) {
        throw new AppError(401, ErrorCode.InvalidCredentials, 'E-mail ou senha incorretos.');
      }
      if (row.status !== 'active') {
        throw new AppError(403, ErrorCode.AccountBlocked, 'Conta bloqueada. Fale com o suporte.');
      }

      const token = generateToken();
      const { rows: s } = await pool.query<{ id: string }>(
        `insert into sessions (user_id, token_hash, expires_at)
         values ($1, $2, now() + make_interval(secs => $3)) returning id`,
        [row.id, sha256Hex(token), SESSION_TTL_SEC],
      );
      // Housekeeping: drop this user's expired sessions.
      await pool.query('delete from sessions where user_id = $1 and expires_at <= now()', [row.id]);
      return { user: toPublic(row), cookieValue: encodeSessionCookie(s[0]!.id, token) };
    },

    async resolveSession(cookieValue) {
      const parsed = parseSessionCookie(cookieValue);
      if (!parsed) return null;
      const { rows } = await pool.query<UserRow & { token_hash: string; expired: boolean }>(
        `select s.token_hash, s.expires_at <= now() as expired,
                u.id, u.email, u.name, u.role, u.status
           from sessions s join users u on u.id = s.user_id
          where s.id = $1`,
        [parsed.sessionId],
      );
      const row = rows[0];
      if (!row || !safeEqual(sha256Hex(parsed.token), row.token_hash)) return null;
      if (row.expired) {
        await pool.query('delete from sessions where id = $1', [parsed.sessionId]);
        return null;
      }
      if (row.status !== 'active') return null;
      return { sessionId: parsed.sessionId, user: toPublic(row) };
    },

    async logout(cookieValue) {
      const parsed = parseSessionCookie(cookieValue);
      if (!parsed) return;
      const { rows } = await pool.query<{ token_hash: string }>('select token_hash from sessions where id = $1', [
        parsed.sessionId,
      ]);
      const row = rows[0];
      if (row && safeEqual(sha256Hex(parsed.token), row.token_hash)) {
        await pool.query('delete from sessions where id = $1', [parsed.sessionId]);
      }
    },

    async requestPasswordReset(email) {
      const { rows } = await pool.query<{ id: string; email: string }>(
        `select id, email from users where email = $1 and status = 'active'`,
        [email],
      );
      const user = rows[0];
      if (!user) return null;
      const token = generateToken();
      await pool.query(
        `insert into password_resets (token_hash, user_id, expires_at)
         values ($1, $2, now() + make_interval(secs => $3))`,
        [sha256Hex(token), user.id, RESET_TTL_SEC],
      );
      return { email: user.email, token };
    },

    async resetPassword({ token, password }) {
      const passwordHash = await hashPassword(password);
      await inTransaction(pool, async (client) => {
        const { rows } = await client.query<{ user_id: string }>(
          `select user_id from password_resets
            where token_hash = $1 and not used and expires_at > now()
            for update`,
          [sha256Hex(token)],
        );
        const reset = rows[0];
        if (!reset) {
          throw new AppError(400, ErrorCode.InvalidToken, 'Link de redefinição inválido ou expirado.');
        }
        await client.query('update users set password_hash = $1 where id = $2', [passwordHash, reset.user_id]);
        // Single use, and any other outstanding links for this user die too.
        await client.query('update password_resets set used = true where user_id = $1 and not used', [
          reset.user_id,
        ]);
        // A password reset logs out every device.
        await client.query('delete from sessions where user_id = $1', [reset.user_id]);
      });
    },
  };
}
