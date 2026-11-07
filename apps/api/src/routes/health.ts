import type { FastifyInstance } from 'fastify';
import { checkHealth, type HealthDeps } from '../lib/health.js';

export function healthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get(
    '/api/health',
    // Uptime checks poll this; keep it out of the per-IP limit and quiet in logs.
    { logLevel: 'warn', config: { rateLimit: false } },
    async (_req, reply) => {
      const result = await checkHealth(deps);
      return reply
        .header('cache-control', 'no-store')
        .status(result.status === 'ok' ? 200 : 503)
        .send(result);
    },
  );
}
