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
import { authOf } from '../plugins/security.js';
import type { PaymentService } from '../services/payments.js';

/** Where the gateway posts status changes. Exempt from CSRF and sessions; authenticated by HMAC signature. */
export const WEBHOOK_PATH = '/api/webhooks/novus';

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
    raw.post(WEBHOOK_PATH, { config: { rateLimit: false } }, async (req, reply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) throw new AppError(400, ErrorCode.BadRequest, 'Corpo vazio.');
      const sig = req.headers['x-webhook-signature'];
      let ok: boolean;
      try {
        ok = await deps.payments.handleWebhook(body, typeof sig === 'string' ? sig : undefined);
      } catch (err) {
        webhooks.inc({ result: 'error' });
        req.log.error({ err }, 'payment webhook failed');
        // 5xx: the gateway retries later.
        throw err;
      }
      if (!ok) {
        webhooks.inc({ result: 'bad_signature' });
        req.log.warn('payment webhook with invalid signature');
        throw new AppError(401, ErrorCode.Unauthorized, 'Assinatura inválida.');
      }
      webhooks.inc({ result: 'ok' });
      return reply.send({ ok: true });
    });
  });
}
