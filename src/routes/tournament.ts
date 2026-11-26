import { Router } from 'express';
import { z } from 'zod';
import { PlayerRequest, requirePlayer } from '../middleware/auth';
import { asyncRoute } from '../middleware/errorHandler';
import { limits } from '../middleware/rateLimits';
import { dbLog } from '../services/logStore';
import { profileSchema } from '../services/profile';
import { tournamentService } from '../services/tournamentService';
import { logBusinessEvent } from '../utils/logger';

/**
 * The Arrow Tournament (services/tournamentRules.ts):
 *
 * GET  /tournament/current                     -> { now, open, window, next, joined, points, group, prizes, result }
 *      result: the last ended window joined: { window, endedAt, place, points, prize|null, taken, top }
 * POST /tournament/join   { name?, avatar?, frame? } -> { window, group }   (409 tournament_closed)
 * POST /tournament/score  { window, points }   -> { window, points, taken, group }   (409 not_joined / tournament_closed, 429 too_soon)
 * POST /tournament/forfeit { window }          -> { window, points: 0, group }   (left a level: the points back to 0)
 * POST /tournament/claim  { window }           -> { window, place, prize }   (once; 409 nothing_to_claim / already_claimed)
 */
const windowId = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
const scoreSchema = z.object({ window: windowId, points: z.number().int().min(1).max(100000) });
const claimSchema = z.object({ window: windowId });

export function createTournamentRouter(): Router {
  const router = Router();
  router.use(requirePlayer, limits.player);

  router.get('/current', asyncRoute<PlayerRequest>(async (req, res) => res.json({ success: true, ...(await tournamentService.current(req.playerId)) })));

  router.post(
    '/join',
    limits.social,
    asyncRoute<PlayerRequest>(async (req, res) => {
      const body = profileSchema.parse(req.body ?? {});
      const r = await tournamentService.join(req.playerId, { name: body.name, avatar: body.avatar, frame: body.frame });
      res.json({ success: true, ...r });
    }),
  );

  router.post(
    '/score',
    limits.leaderboardWrite,
    asyncRoute<PlayerRequest>(async (req, res) => {
      const body = scoreSchema.parse(req.body);
      const r = await tournamentService.score(req.playerId, body.window, body.points);
      if (r.taken < body.points) dbLog.security('tournament_capped', { window: body.window, sent: body.points, taken: r.taken });
      res.json({ success: true, ...r });
    }),
  );

  router.post(
    '/forfeit',
    limits.social,
    asyncRoute<PlayerRequest>(async (req, res) => {
      const body = claimSchema.parse(req.body);
      res.json({ success: true, ...(await tournamentService.forfeit(req.playerId, body.window)) });
    }),
  );

  router.post(
    '/claim',
    limits.social,
    asyncRoute<PlayerRequest>(async (req, res) => {
      const body = claimSchema.parse(req.body);
      const r = await tournamentService.claim(req.playerId, body.window);
      logBusinessEvent('tournament_prize', { window: r.window, place: r.place });
      dbLog.event('tournament_prize', { window: r.window, place: r.place });
      res.json({ success: true, ...r });
    }),
  );

  return router;
}
