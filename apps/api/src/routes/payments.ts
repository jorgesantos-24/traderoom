import type { FastifyInstance } from 'fastify';
import {
  AdminRejectInput,
  AdminWithdrawalsQuery,
  CreateDepositInput,
  CreateWithdrawalInput,
  ErrorCode,
  PaymentIdParams,
  type Counter,
  type Registry,
} from '@traderoom/shared';
import { AppError } from '../lib/errors.js';
import { webhookPath, type GatewayName } from '../lib/gateway.js';
import { authOf } from '../plugins/security.js';
import type { PaymentService } from '../services/payments.js';

/** Each gateway posts to its own path (see webhookPath); exempt from CSRF and sessions, authenticated by signature. */
const WEBHOOK_PROVIDERS: GatewayName[] = ['novus', 'eagle'];

export function paymentRoutes(app: FastifyInstance, deps: { payments: PaymentService; metrics: Registry }): void {
  const webhooks: Counter = deps.metrics.counter('payment_webhooks_total', 'Gateway notifications, by result.');
  const noStore = 'no-store';
  const auth = { preHandler: app.requireAuth };
  const admin = { preHandler: app.requireAdmin };

  app.get('/api/payments', auth, async (req, reply) => {
    const userId = authOf(req).user.id;
    const [info, deposits, withdrawals] = await Promise.all([
      deps.payments.info(userId),
      deps.payments.listDeposits(userId),
      deps.payments.listWithdrawals(userId),
    ]);
    return reply.header('cache-control', noStore).send({ info, deposits, withdrawals });
  });

  app.post('/api/deposits', auth, async (req, reply) => {
    const input = CreateDepositInput.parse(req.body);
    const deposit = await deps.payments.createDeposit(authOf(req).user.id, input);
    req.log.info({ depositId: deposit.id, amountCents: deposit.amountCents }, 'deposit created');
    return reply.status(201).header('cache-control', noStore).send({ deposit });
  });

  app.get('/api/deposits/:id', auth, async (req, reply) => {
    const { id } = PaymentIdParams.parse(req.params);
    return reply.header('cache-control', noStore).send({ deposit: await deps.payments.getDeposit(authOf(req).user.id, id) });
  });

  app.post('/api/withdrawals', auth, async (req, reply) => {
    const input = CreateWithdrawalInput.parse(req.body);
    const withdrawal = await deps.payments.requestWithdrawal(authOf(req).user.id, input);
    req.log.info({ withdrawalId: withdrawal.id, amountCents: withdrawal.amountCents }, 'withdrawal requested');
    return reply.status(201).header('cache-control', noStore).send({ withdrawal });
  });

  app.post('/api/withdrawals/:id/cancel', auth, async (req, reply) => {
    const { id } = PaymentIdParams.parse(req.params);
    const withdrawal = await deps.payments.cancelWithdrawal(authOf(req).user.id, id);
    req.log.info({ withdrawalId: id, amountCents: withdrawal.amountCents }, 'withdrawal canceled by client');
    return reply.header('cache-control', noStore).send({ withdrawal });
  });

  app.get('/api/admin/withdrawals', admin, async (req, reply) => {
    const q = AdminWithdrawalsQuery.parse(req.query);
    return reply.header('cache-control', noStore).send(await deps.payments.adminList(q));
  });

  app.post('/api/admin/withdrawals/:id/approve', admin, async (req, reply) => {
    const { id } = PaymentIdParams.parse(req.params);
    const withdrawal = await deps.payments.approve(authOf(req).user.id, id);
    req.log.info({ withdrawalId: id, status: withdrawal.status }, 'withdrawal approved');
    return reply.header('cache-control', noStore).send({ withdrawal });
  });

  app.post('/api/admin/withdrawals/:id/reject', admin, async (req, reply) => {
    const { id } = PaymentIdParams.parse(req.params);
    const { note } = AdminRejectInput.parse(req.body);
    const withdrawal = await deps.payments.reject(authOf(req).user.id, id, note);
    req.log.info({ withdrawalId: id }, 'withdrawal rejected');
    return reply.header('cache-control', noStore).send({ withdrawal });
  });

  app.post('/api/admin/withdrawals/:id/refresh', admin, async (req, reply) => {
    const { id } = PaymentIdParams.parse(req.params);
    return reply.header('cache-control', noStore).send({ withdrawal: await deps.payments.refreshWithdrawal(id) });
  });

  // The signature covers the exact bytes, so this route keeps the raw body.
  void app.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 64 * 1024 }, (_req, body, done) => done(null, body));
    for (const provider of WEBHOOK_PROVIDERS) {
      raw.post(webhookPath(provider), { config: { rateLimit: false } }, async (req, reply) => {
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) throw new AppError(400, ErrorCode.BadRequest, 'Corpo vazio.');
        let ok: boolean;
        try {
          ok = await deps.payments.handleWebhook(provider, body, req.headers);
        } catch (err) {
          webhooks.inc({ provider, result: 'error' });
          req.log.error({ err, provider }, 'payment webhook failed');
          // 5xx: the gateway retries later.
          throw err;
        }
        if (!ok) {
          webhooks.inc({ provider, result: 'bad_signature' });
          req.log.warn({ provider }, 'payment webhook with invalid signature');
          throw new AppError(401, ErrorCode.Unauthorized, 'Assinatura inválida.');
        }
        webhooks.inc({ provider, result: 'ok' });
        return reply.send({ ok: true });
      });
    }
  });
}
