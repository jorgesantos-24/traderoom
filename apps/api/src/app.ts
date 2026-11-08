import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Registry } from '@traderoom/shared';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import type { HealthDeps } from './lib/health.js';
import type { Mailer } from './lib/mailer.js';
import { registerSecurity, type SecuritySettings } from './plugins/security.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { marketRoutes } from './routes/market.js';
import { metricsRoute, orderRoutes } from './routes/orders.js';
import type { AdminService } from './services/admin.js';
import type { AssetRepo } from './services/assets.js';
import type { OrderLimitsRepo } from './services/order-limits.js';
import type { AuthService } from './services/auth.js';
import type { CandleService } from './services/candles.js';
import type { CandleInterval } from '@traderoom/shared';
import type { OrderService } from './services/orders.js';
import type { WalletService } from './services/wallet.js';
import type { PaymentService } from './services/payments.js';
import { paymentRoutes } from './routes/payments.js';
import { kycRoutes } from './routes/kyc.js';
import { otcOverrideRoutes } from './routes/otc-override.js';
import type { OtcOverrideService } from './services/otc-override.js';
import type { OverrideMarkSource } from './services/override-marks.js';
import type { KycService } from './services/kyc.js';

export const BODY_LIMIT_BYTES = 16 * 1024;

export interface AppDeps {
  health: HealthDeps;
  auth: AuthService;
  /** Built after the logger exists so dev mailers can log through it. */
  createMailer: (log: FastifyBaseLogger) => Mailer;
  createCandles: (log: FastifyBaseLogger) => CandleService;
  orders: OrderService;
  wallet: WalletService;
  assets: AssetRepo;
  limits: OrderLimitsRepo;
  admin: AdminService;
  payments: PaymentService;
  kyc: KycService;
  otcOverride: OtcOverrideService;
  /** Marks on candles whose close a price override set. */
  overrideMarks: OverrideMarkSource;
  metrics: Registry;
}

export interface AppOptions {
  logger: FastifyServerOptions['logger'];
  publicOrigin: string;
  security: SecuritySettings;
  /** Extra routes, registered before the app is sealed. Used by tests. */
  extend?: (app: FastifyInstance) => void;
  /** Chart intervals kept warm in the candle cache (none in tests). */
  warmCandleIntervals?: readonly CandleInterval[];
}

export function loggerOptions(level: string): FastifyServerOptions['logger'] {
  return {
    level,
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.token',
        '*.passwordHash',
      ],
      censor: '[redacted]',
    },
  };
}

export async function buildApp(deps: AppDeps, opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger,
    bodyLimit: BODY_LIMIT_BYTES,
    // Logged as `reqId` (Fastify default label).
    genReqId: () => randomUUID(),
    // Only Caddy on localhost may set X-Forwarded-For.
    trustProxy: '127.0.0.1',
  });

  app.addHook('onRequest', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });
  const responses = deps.metrics.counter('http_responses_total', 'HTTP responses, by status code.');
  app.addHook('onResponse', async (_req, reply) => {
    responses.inc({ status: String(reply.statusCode) });
  });
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  // JSON only: nothing here should ever be rendered or framed. The SPA's own CSP is set by Caddy.
  await app.register(helmet, {
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
  });
  // The front is same-origin; CORS only answers for that one origin, so no other site can read responses.
  await app.register(cors, {
    origin: opts.publicOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'idempotency-key'],
    maxAge: 600,
  });

  await registerSecurity(app, deps.auth, opts.security);

  healthRoutes(app, deps.health);
  authRoutes(app, { auth: deps.auth, mailer: deps.createMailer(app.log), publicOrigin: opts.publicOrigin });
  const candles = deps.createCandles(app.log);
  if (opts.warmCandleIntervals?.length) {
    const stopWarming = candles.startWarming(opts.warmCandleIntervals);
    app.addHook('onClose', async () => stopWarming());
  }
  marketRoutes(app, { candles, marks: deps.overrideMarks });
  orderRoutes(app, { orders: deps.orders, wallet: deps.wallet, assets: deps.assets, limits: deps.limits, metrics: deps.metrics });
  adminRoutes(app, { admin: deps.admin, metrics: deps.metrics });
  otcOverrideRoutes(app, { otcOverride: deps.otcOverride, metrics: deps.metrics });
  paymentRoutes(app, { payments: deps.payments, metrics: deps.metrics });
  kycRoutes(app, { kyc: deps.kyc });
  metricsRoute(app, deps.metrics);
  opts.extend?.(app);

  await app.ready();
  return app;
}
