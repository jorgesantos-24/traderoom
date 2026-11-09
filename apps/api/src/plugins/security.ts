import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { CSRF_HEADER, ErrorCode, SESSION_COOKIE } from '@traderoom/shared';
import { AppError } from '../lib/errors.js';
import { WEBHOOK_PATHS } from '../lib/gateway.js';
import { generateToken, safeEqual } from '../lib/tokens.js';
import { SESSION_TTL_SEC, type AuthService, type SessionInfo } from '../services/auth.js';

export { SESSION_COOKIE };

export interface SecuritySettings {
  /** False only for plain-http testing off localhost. */
  cookieSecure: boolean;
  rateLimit: {
    /** Null uses the in-process store (tests). */
    redis: Redis | null;
    nameSpace: string;
    globalMax: number;
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: SessionInfo | null;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    csrf: {
      cookieName: string;
      issue: (reply: FastifyReply) => string;
      current: (req: FastifyRequest) => string | undefined;
    };
    sessionCookie: {
      set: (reply: FastifyReply, value: string) => void;
      clear: (reply: FastifyReply) => void;
      read: (req: FastifyRequest) => string | undefined;
    };
  }
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** The only state-changing route exempt from CSRF (spec). It rotates the CSRF token itself. */
// The payment gateway's webhook has no cookies; it is authenticated by its HMAC signature instead.
const CSRF_EXEMPT = new Set(['/api/auth/login', ...WEBHOOK_PATHS]);

/** Use inside handlers behind `requireAuth`. */
export function authOf(req: FastifyRequest): SessionInfo {
  if (!req.auth) throw new AppError(401, ErrorCode.Unauthorized, 'Sessão inválida ou expirada.');
  return req.auth;
}

export async function registerSecurity(app: FastifyInstance, auth: AuthService, settings: SecuritySettings): Promise<void> {
  await app.register(cookie);

  await app.register(rateLimit, {
    global: true,
    max: settings.rateLimit.globalMax,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    nameSpace: settings.rateLimit.nameSpace,
    // A Redis blip must not take the whole API down; limits resume when it is back.
    skipOnError: true,
    ...(settings.rateLimit.redis ? { redis: settings.rateLimit.redis } : {}),
  });

  // `__Host-` prefix (Secure, Path=/, no Domain) stops subdomains from planting a CSRF cookie.
  const csrfCookieName = settings.cookieSecure ? '__Host-csrf' : 'csrf';
  const baseCookie = { path: '/', sameSite: 'lax' as const, secure: settings.cookieSecure };

  app.decorate('csrf', {
    cookieName: csrfCookieName,
    issue(reply: FastifyReply): string {
      const token = generateToken();
      void reply.setCookie(csrfCookieName, token, { ...baseCookie, httpOnly: false, maxAge: SESSION_TTL_SEC });
      return token;
    },
    current(req: FastifyRequest): string | undefined {
      return req.cookies[csrfCookieName];
    },
  });

  app.decorate('sessionCookie', {
    set(reply: FastifyReply, value: string): void {
      void reply.setCookie(SESSION_COOKIE, value, { ...baseCookie, httpOnly: true, maxAge: SESSION_TTL_SEC });
    },
    clear(reply: FastifyReply): void {
      void reply.clearCookie(SESSION_COOKIE, { ...baseCookie, httpOnly: true });
    },
    read(req: FastifyRequest): string | undefined {
      return req.cookies[SESSION_COOKIE];
    },
  });

  // Double-submit check. Runs before route preHandlers (requireAuth), after cookies are parsed.
  app.addHook('preHandler', async (req) => {
    if (!UNSAFE_METHODS.has(req.method)) return;
    const route = req.routeOptions.url;
    if (route === undefined || CSRF_EXEMPT.has(route)) return;
    const fromCookie = req.cookies[csrfCookieName];
    const fromHeader = req.headers[CSRF_HEADER];
    if (typeof fromCookie !== 'string' || typeof fromHeader !== 'string' || fromCookie.length === 0 || !safeEqual(fromCookie, fromHeader)) {
      throw new AppError(403, ErrorCode.CsrfFailed, 'Token CSRF ausente ou inválido. Recarregue a página.');
    }
  });

  app.decorateRequest('auth', null);

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    const session = await auth.resolveSession(req.cookies[SESSION_COOKIE]);
    if (!session) throw new AppError(401, ErrorCode.Unauthorized, 'Sessão inválida ou expirada.');
    req.auth = session;
  });

  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    await app.requireAuth(req, reply);
    if (req.auth?.user.role !== 'admin') throw new AppError(403, ErrorCode.Forbidden, 'Acesso restrito.');
  });
}
