import type { FastifyInstance } from 'fastify';
import { CandlesQuery, type CandlesResponse } from '@traderoom/shared';
import type { CandleService } from '../services/candles.js';

export function marketRoutes(app: FastifyInstance, deps: { candles: CandleService }): void {
  app.get('/api/candles', { preHandler: app.requireAuth }, async (req, reply) => {
    const q = CandlesQuery.parse(req.query);
    const candles = await deps.candles.get(q.symbol, q.interval, q.limit, q.before);
    const body: CandlesResponse = { symbol: q.symbol, interval: q.interval, candles };
    // The server cache is 30 s; a short private cache only absorbs quick reloads. Older pages do not change.
    return reply.header('cache-control', q.before !== undefined ? 'private, max-age=300' : 'private, max-age=5').send(body);
  });
}
