import { Router } from 'express';
import { z } from 'zod';
import { PlayerRequest, requirePlayer } from '../middleware/auth';
import { asyncRoute } from '../middleware/errorHandler';
import { limits } from '../middleware/rateLimits';
import { dbLog } from '../services/logStore';
import { logger } from '../utils/logger';

/**
 * POST /logs/client  { events: [{ name, level, at, data }] }
 *
 * What the game itself saw go wrong (a purchase the store failed, a request that never got an
 * answer), sent in small batches. It lands next to the server's own rows, under the same
 * player, so one search shows both sides.
 */
const schema = z.object({
  events: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        level: z.enum(['info', 'warn', 'error']).default('info'),
        at: z.number().int().optional(),
        requestId: z.string().max(80).optional(),
        data: z.record(z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(25),
});

export function createClientLogRouter(): Router {
  const router = Router();
  router.use(requirePlayer, limits.clientLogs);

  router.post(
    '/client',
    asyncRoute<PlayerRequest>(async (req, res) => {
      const { events } = schema.parse(req.body);
      for (const e of events) {
        logger[e.level]({ clientEvent: e.name, clientAt: e.at ? new Date(e.at).toISOString() : undefined, clientRequestId: e.requestId, data: e.data }, `Client: ${e.name}`);
        dbLog.client(e.name, e.level, { clientAt: e.at ?? null, clientRequestId: e.requestId ?? null, ...e.data });
      }
      res.json({ success: true, received: events.length });
    }),
  );

  return router;
}
