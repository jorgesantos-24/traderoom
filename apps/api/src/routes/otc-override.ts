import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OtcExposureQuery, OtcOverrideInput, SymbolSchema, type Counter, type Registry } from '@traderoom/shared';
import { authOf } from '../plugins/security.js';
import type { OtcOverrideService } from '../services/otc-override.js';

export function otcOverrideRoutes(app: FastifyInstance, deps: { otcOverride: OtcOverrideService; metrics: Registry }): void {
  const actions: Counter = deps.metrics.counter('otc_override_actions_total', 'OTC price overrides applied and released, by action.');
  const guard = { preHandler: app.requireAdmin };
  const noStore = 'no-store';

  app.get('/api/admin/otc-override', guard, async (_req, reply) => {
    return reply.header('cache-control', noStore).send(await deps.otcOverride.get());
  });

  app.get('/api/admin/otc-override/exposure', guard, async (req, reply) => {
    const q = OtcExposureQuery.parse(req.query);
    return reply.header('cache-control', noStore).send(await deps.otcOverride.exposure(q));
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

  // Any signed-in client: shown as a badge while the platform sets this asset's price.
  const PublicQuery = z.object({ symbol: SymbolSchema });
  app.get('/api/market/override', { preHandler: app.requireAuth }, async (req, reply) => {
    const { symbol } = PublicQuery.parse(req.query);
    return reply.header('cache-control', noStore).send(await deps.otcOverride.publicState(symbol));
  });

  app.delete('/api/admin/otc-override', guard, async (req, reply) => {
    const released = await deps.otcOverride.release(authOf(req).user.id);
    if (released) actions.inc({ action: 'otc.override.release' });
    req.log.info({ released }, 'admin otc override release');
    return reply.header('cache-control', noStore).send({ released });
  });
}
