import type { FastifyInstance } from 'fastify';
import { ForgotInput, LoginInput, RegisterInput, ResetInput } from '@traderoom/shared';
import type { Mailer } from '../lib/mailer.js';
import { authOf } from '../plugins/security.js';
import type { AuthService } from '../services/auth.js';

export interface AuthRouteDeps {
  auth: AuthService;
  mailer: Mailer;
  publicOrigin: string;
}

export function authRoutes(app: FastifyInstance, { auth, mailer, publicOrigin }: AuthRouteDeps): void {
  app.get('/api/auth/csrf', { config: { rateLimit: false } }, async (req, reply) => {
    const token = app.csrf.current(req) ?? app.csrf.issue(reply);
    return reply.header('cache-control', 'no-store').send({ csrfToken: token });
  });

  // TEMP: no rate limit at all (not even the global one); restore { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }
  app.post('/api/auth/register', { config: { rateLimit: false } }, async (req, reply) => {
    const input = RegisterInput.parse(req.body);
    const user = await auth.register(input);
    return reply.status(201).send({ user });
  });

  // TEMP: no rate limit at all (not even the global one); restore { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }
  app.post('/api/auth/login', { config: { rateLimit: false } }, async (req, reply) => {
    const input = LoginInput.parse(req.body);
    const { user, cookieValue } = await auth.login(input);
    app.sessionCookie.set(reply, cookieValue);
    // New session, new CSRF token.
    const csrfToken = app.csrf.issue(reply);
    return reply.header('cache-control', 'no-store').send({ user, csrfToken });
  });

  app.post('/api/auth/logout', { config: { rateLimit: false } }, async (req, reply) => {
    await auth.logout(app.sessionCookie.read(req));
    app.sessionCookie.clear(reply);
    return reply.status(204).send();
  });

  // TEMP: no rate limit at all (not even the global one); restore { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }
  app.post('/api/auth/forgot', { config: { rateLimit: false } }, async (req, reply) => {
    const { email } = ForgotInput.parse(req.body);
    const reset = await auth.requestPasswordReset(email);
    if (reset) {
      const link = `${publicOrigin}/reset?token=${encodeURIComponent(reset.token)}`;
      // Not awaited: same response time whether or not the e-mail exists.
      mailer.sendPasswordReset(reset.email, link).catch((err: unknown) => {
        req.log.error({ err }, 'failed to send password reset e-mail');
      });
    }
    // Always the same answer, so this endpoint does not reveal registered e-mails.
    return reply.status(204).send();
  });

  // TEMP: no rate limit at all (not even the global one); restore { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }
  app.post('/api/auth/reset', { config: { rateLimit: false } }, async (req, reply) => {
    const input = ResetInput.parse(req.body);
    await auth.resetPassword(input);
    app.sessionCookie.clear(reply);
    return reply.status(204).send();
  });

  app.get('/api/me', { config: { rateLimit: false }, preHandler: app.requireAuth }, async (req, reply) => {
    return reply.header('cache-control', 'no-store').send({ user: authOf(req).user });
  });
}
