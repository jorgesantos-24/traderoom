import type { FastifyInstance } from 'fastify';
import { CandlesQuery, type CandlesResponse } from '@traderoom/shared';
import type { CandleService } from '../services/candles.js';

export function marketRoutes(app: FastifyInstance, deps: { candles: CandleService }): void {
  app.get('/api/candles', { preHandler: app.requireAuth }, async (req, reply) => {
    const q = CandlesQuery.parse(req.query);
    const candles = await deps.candles.get(q.symbol, q.interval, q.limit);
    const body: CandlesResponse = { symbol: q.symbol, interval: q.interval, candles };
    // The server cache is 30 s; a short private cache only absorbs quick reloads.
    return reply.header('cache-control', 'private, max-age=5').send(body);
  });
}
