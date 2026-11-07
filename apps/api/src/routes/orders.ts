import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AccountQuery,
  CreateOrderInput,
  ErrorCode,
  IDEMPOTENCY_HEADER,
  IdempotencyKeySchema,
  ListLedgerQuery,
  ListOrdersQuery,
  type Counter,
  type Registry,
} from '@traderoom/shared';
import { AppError } from '../lib/errors.js';
import { authOf } from '../plugins/security.js';
import type { AssetRepo } from '../services/assets.js';
import type { OrderLimitsRepo } from '../services/order-limits.js';
import type { OrderService } from '../services/orders.js';
import type { WalletService } from '../services/wallet.js';

/** Spec: 30 orders per minute per user. */
export const ORDERS_PER_MINUTE = 30;

export interface OrderRouteDeps {
  orders: OrderService;
  wallet: WalletService;
  assets: AssetRepo;
  limits: OrderLimitsRepo;
  metrics: Registry;
}

export function orderRoutes(app: FastifyInstance, deps: OrderRouteDeps): void {
  const created: Counter = deps.metrics.counter('orders_created_total', 'Orders accepted, by direction.');
  const rejected: Counter = deps.metrics.counter('orders_rejected_total', 'Order requests refused, by error code.');
  const replayed: Counter = deps.metrics.counter('orders_replayed_total', 'Order requests answered from an earlier Idempotency-Key.');

  // Keyed by user (not IP) and checked after auth; counters live in the same store as the global limit.
  const checkOrderLimit = app.createRateLimit({
    max: ORDERS_PER_MINUTE,
    timeWindow: 60_000,
    keyGenerator: (req: FastifyRequest) => `orders:${authOf(req).user.id}`,
  });
  const limitOrders = async (req: FastifyRequest): Promise<void> => {
    const limit = await checkOrderLimit(req);
    if (!limit.isAllowed && limit.isExceeded) {
      rejected.inc({ code: ErrorCode.RateLimited });
      throw new AppError(429, ErrorCode.RateLimited, `Limite de ${ORDERS_PER_MINUTE} ordens por minuto atingido.`);
    }
  };

  app.get('/api/assets', { preHandler: app.requireAuth }, async (_req, reply) => {
    const [{ byId }, limits] = await Promise.all([deps.assets.enabled(), deps.limits.get()]);
    return reply.header('cache-control', 'private, max-age=10').send({ assets: [...byId.values()], limits });
  });

  app.post('/api/orders', { preHandler: [app.requireAuth, limitOrders] }, async (req, reply) => {
    const user = authOf(req).user;
    try {
      const key = IdempotencyKeySchema.parse(req.headers[IDEMPOTENCY_HEADER]);
      const input = CreateOrderInput.parse(req.body);
      const result = await deps.orders.create(user.id, input, key);
      if (result.replayed) replayed.inc();
      else created.inc({ direction: input.direction });
      return reply
        .status(result.replayed ? 200 : 201)
        .header('cache-control', 'no-store')
        .header('idempotency-replayed', String(result.replayed))
        .send({ order: result.order });
    } catch (err) {
      rejected.inc({ code: err instanceof AppError ? err.code : ErrorCode.ValidationFailed });
      throw err;
    }
  });

  app.get('/api/orders', { preHandler: app.requireAuth }, async (req, reply) => {
    const q = ListOrdersQuery.parse(req.query);
    return reply.header('cache-control', 'no-store').send(await deps.orders.list(authOf(req).user.id, q));
  });

  app.get('/api/wallet', { preHandler: app.requireAuth }, async (req, reply) => {
    const { account } = AccountQuery.parse(req.query);
    return reply.header('cache-control', 'no-store').send({ wallet: await deps.wallet.get(authOf(req).user.id, account) });
  });

  /** Real and demo balances, for the account switcher. */
  app.get('/api/accounts', { preHandler: app.requireAuth }, async (req, reply) => {
    return reply.header('cache-control', 'no-store').send({ accounts: await deps.wallet.all(authOf(req).user.id) });
  });

  app.post('/api/accounts/demo/refill', { preHandler: app.requireAuth }, async (req, reply) => {
    return reply.header('cache-control', 'no-store').send({ wallet: await deps.wallet.refillDemo(authOf(req).user.id) });
  });

  app.get('/api/ledger', { preHandler: app.requireAuth }, async (req, reply) => {
    const q = ListLedgerQuery.parse(req.query);
    return reply.header('cache-control', 'no-store').send(await deps.wallet.ledger(authOf(req).user.id, q));
  });
}

/** Prometheus scrape endpoint. Never proxied: Caddy forwards only /api/* and /ws. */
export function metricsRoute(app: FastifyInstance, metrics: Registry): void {
  app.get('/metrics', { logLevel: 'warn', config: { rateLimit: false } }, async (req, reply) => {
    // Anything that came through the proxy carries X-Forwarded-For: refuse it as if the route did not exist.
    if (req.headers['x-forwarded-for'] !== undefined) throw new AppError(404, ErrorCode.NotFound, 'Recurso não encontrado.');
    return reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8').send(metrics.render());
  });
}
