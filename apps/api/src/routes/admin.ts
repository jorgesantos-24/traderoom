import type { FastifyInstance } from 'fastify';
import {
  AdminAssetPatch,
  AdminAuditQuery,
  AdminBlockInput,
  AdminCreditInput,
  AdminIndicatorGrant,
  AdminUsersQuery,
  AssetIdParams,
  IDEMPOTENCY_HEADER,
  IdempotencyKeySchema,
  IndicatorAccessParams,
  UserIdParams,
  type IndicatorAccessResponse,
  type Counter,
  type Registry,
} from '@traderoom/shared';
import { authOf } from '../plugins/security.js';
import type { AdminService } from '../services/admin.js';

export function adminRoutes(app: FastifyInstance, deps: { admin: AdminService; metrics: Registry }): void {
  const actions: Counter = deps.metrics.counter('admin_actions_total', 'Admin changes, by action.');
  const guard = { preHandler: app.requireAdmin };
  const noStore = 'no-store';

  app.get('/api/admin/users', guard, async (req, reply) => {
    const q = AdminUsersQuery.parse(req.query);
    return reply.header('cache-control', noStore).send(await deps.admin.listUsers(q));
  });

  app.post('/api/admin/users/:id/credit', guard, async (req, reply) => {
    const { id } = UserIdParams.parse(req.params);
    const key = IdempotencyKeySchema.parse(req.headers[IDEMPOTENCY_HEADER]);
    const input = AdminCreditInput.parse(req.body);
    const r = await deps.admin.adjustBalance(authOf(req).user.id, id, input.deltaCents, input.note, key);
    if (!r.replayed) actions.inc({ action: input.deltaCents > 0 ? 'user.credit' : 'user.debit' });
    req.log.info({ userId: id, deltaCents: input.deltaCents, ledgerId: r.ledgerId, replayed: r.replayed }, 'admin balance adjustment');
    return reply
      .header('cache-control', noStore)
      .header('idempotency-replayed', String(r.replayed))
      .send({ user: r.user, ledgerId: r.ledgerId });
  });

  app.post('/api/admin/users/:id/block', guard, async (req, reply) => {
    const { id } = UserIdParams.parse(req.params);
    const { blocked } = AdminBlockInput.parse(req.body ?? undefined);
    const user = await deps.admin.setBlocked(authOf(req).user.id, id, blocked);
    actions.inc({ action: blocked ? 'user.block' : 'user.unblock' });
    req.log.info({ userId: id, blocked }, 'admin block change');
    return reply.header('cache-control', noStore).send({ user });
  });

  app.get('/api/admin/assets', guard, async (_req, reply) => {
    return reply.header('cache-control', noStore).send({ assets: await deps.admin.listAssets() });
  });

  app.patch('/api/admin/assets/:id', guard, async (req, reply) => {
    const { id } = AssetIdParams.parse(req.params);
    const patch = AdminAssetPatch.parse(req.body);
    const asset = await deps.admin.updateAsset(authOf(req).user.id, id, patch);
    actions.inc({ action: 'asset.update' });
    req.log.info({ assetId: id, patch }, 'admin asset update');
    return reply.header('cache-control', noStore).send({ asset });
  });

  // Premium chart indicators: the signed-in user's own access, and the admin list.
  app.get('/api/indicators/access', { preHandler: app.requireAuth }, async (req, reply) => {
    const { user } = authOf(req);
    const body: IndicatorAccessResponse = { indicators: await deps.admin.allowedIndicators(user.id, user.role) };
    return reply.header('cache-control', noStore).send(body);
  });

  app.get('/api/admin/indicators', guard, async (_req, reply) => {
    return reply.header('cache-control', noStore).send({ access: await deps.admin.listIndicatorAccess() });
  });

  app.post('/api/admin/indicators', guard, async (req, reply) => {
    const { email, indicator } = AdminIndicatorGrant.parse(req.body);
    const access = await deps.admin.grantIndicator(authOf(req).user.id, email, indicator);
    actions.inc({ action: 'indicator.grant' });
    req.log.info({ userId: access.userId, indicator }, 'admin indicator grant');
    return reply.header('cache-control', noStore).send({ access });
  });

  app.delete('/api/admin/indicators/:userId/:indicator', guard, async (req, reply) => {
    const { userId, indicator } = IndicatorAccessParams.parse(req.params);
    await deps.admin.revokeIndicator(authOf(req).user.id, userId, indicator);
    actions.inc({ action: 'indicator.revoke' });
    req.log.info({ userId, indicator }, 'admin indicator revoke');
    return reply.header('cache-control', noStore).code(204).send();
  });

  app.get('/api/admin/audit', guard, async (req, reply) => {
    const q = AdminAuditQuery.parse(req.query);
    return reply.header('cache-control', noStore).send(await deps.admin.listAudit(q));
  });
}
