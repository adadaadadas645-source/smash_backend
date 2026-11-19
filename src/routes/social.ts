import { Router } from 'express';
import { z } from 'zod';
import { PlayerRequest, requirePlayer } from '../middleware/auth';
import { asyncRoute } from '../middleware/errorHandler';
import { limits } from '../middleware/rateLimits';
import { socialService } from '../services/socialService';

/**
 * GET  /social/weekly               -> { week, endsInMs, prizes, top, me, total }
 * GET  /social/weekly/last          -> { week, place, points, prize, taken }   (last week's race; prize in the first three)
 * POST /social/weekly/claim         -> { week, place, prize }   (once; 409 nothing_to_claim / already_claimed)
 * GET  /social/country/:cc          -> { country, top, me, total }
 * GET  /social/friends              -> { code, friends, incoming, outgoing }
 * GET  /social/friends/suggested    -> { players }
 * POST /social/friends/request      { code } -> { status }
 * POST /social/friends/answer       { playerId, accept }
 * POST /social/friends/remove       { playerId }
 */
const playerId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

export function createSocialRouter(): Router {
  const router = Router();
  router.use(requirePlayer, limits.player);

  router.get('/weekly', asyncRoute<PlayerRequest>(async (req, res) => res.json({ success: true, ...(await socialService.weekly(req.playerId)) })));
  router.get('/weekly/last', asyncRoute<PlayerRequest>(async (req, res) => res.json({ success: true, ...(await socialService.lastWeek(req.playerId)) })));
  router.post('/weekly/claim', limits.social, asyncRoute<PlayerRequest>(async (req, res) => res.json({ success: true, ...(await socialService.claimLastWeek(req.playerId)) })));
  router.get('/country/:cc', asyncRoute<PlayerRequest>(async (req, res) => res.json({ success: true, ...(await socialService.country(req.playerId, String(req.params.cc))) })));
  router.get('/friends', asyncRoute<PlayerRequest>(async (req, res) => res.json({ success: true, ...(await socialService.friends(req.playerId)) })));
  router.get('/friends/suggested', limits.social, asyncRoute<PlayerRequest>(async (req, res) => res.json({ success: true, players: await socialService.suggested(req.playerId) })));
  router.post('/friends/request', limits.social, asyncRoute<PlayerRequest>(async (req, res) => {
    const body = z.object({ code: z.string().min(1).max(20) }).parse(req.body);
    res.json({ success: true, ...(await socialService.request(req.playerId, body.code)) });
  }));
  router.post('/friends/answer', limits.social, asyncRoute<PlayerRequest>(async (req, res) => {
    const body = z.object({ playerId, accept: z.boolean() }).parse(req.body);
    await socialService.answer(req.playerId, body.playerId, body.accept);
    res.json({ success: true });
  }));
  router.post('/friends/remove', limits.social, asyncRoute<PlayerRequest>(async (req, res) => {
    const body = z.object({ playerId }).parse(req.body);
    await socialService.remove(req.playerId, body.playerId);
    res.json({ success: true });
  }));
  return router;
}
