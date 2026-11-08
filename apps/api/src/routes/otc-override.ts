import type { FastifyInstance } from 'fastify';
import { OtcOverrideInput, type Counter, type Registry } from '@traderoom/shared';
import { authOf } from '../plugins/security.js';
import type { OtcOverrideService } from '../services/otc-override.js';

export function otcOverrideRoutes(app: FastifyInstance, deps: { otcOverride: OtcOverrideService; metrics: Registry }): void {
  const actions: Counter = deps.metrics.counter('otc_override_actions_total', 'OTC price overrides applied and released, by action.');
  const guard = { preHandler: app.requireAdmin };
  const noStore = 'no-store';

  app.get('/api/admin/otc-override', guard, async (_req, reply) => {
    return reply.header('cache-control', noStore).send(await deps.otcOverride.get());
  });

  app.post('/api/admin/otc-override', guard, async (req, reply) => {
    const input = OtcOverrideInput.parse(req.body);
    const override = await deps.otcOverride.apply(authOf(req).user.id, input);
    actions.inc({ action: 'otc.override' });
    req.log.info(
      { overrideId: override.id, symbol: override.symbol, targetPrice: override.targetPrice, closeMs: override.candleCloseMs },
      'admin otc override',
    );
    return reply.header('cache-control', noStore).send({ override });
  });

  app.delete('/api/admin/otc-override', guard, async (req, reply) => {
    const released = await deps.otcOverride.release(authOf(req).user.id);
    if (released) actions.inc({ action: 'otc.override.release' });
    req.log.info({ released }, 'admin otc override release');
    return reply.header('cache-control', noStore).send({ released });
  });
}
