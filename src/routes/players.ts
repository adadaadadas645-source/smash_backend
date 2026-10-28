import { Router } from 'express';
import { PlayerRequest, requirePlayer } from '../middleware/auth';
import { AppError, asyncRoute } from '../middleware/errorHandler';
import { limits } from '../middleware/rateLimits';
import { dbLog } from '../services/logStore';
import { playerService, publicPlayer } from '../services/playerService';
import { profileSchema } from '../services/profile';
import { z } from 'zod';
import { accountService } from '../services/accountService';
import { saveSchema, saveService } from '../services/saveService';

/**
 * GET   /players/me  -> { player }  (what was bought for good comes back from here: noAdsForever)
 * PATCH /players/me  { name?, avatar?, frame?, locale? } -> { player }  (the name stays the username once there is one)
 * POST  /players/me/account  { username, password } -> { player }  (once: 409 username_taken / account_exists)
 * GET   /players/me/save  -> { save: { rev, keys } | null }
 * PUT   /players/me/save  { rev, keys } -> { rev }  (409 stale_save when a newer one is stored)
 */
export function createPlayerRouter(): Router {
  const router = Router();
  router.use(requirePlayer, limits.player);

  router.get(
    '/me',
    asyncRoute<PlayerRequest>(async (req, res) => {
      const doc = await playerService.get(req.playerId);
      if (!doc) throw new AppError(404, 'player_not_found');
      res.json({ success: true, player: publicPlayer(doc) });
    }),
  );

  router.patch(
    '/me',
    asyncRoute<PlayerRequest>(async (req, res) => {
      const body = profileSchema.parse(req.body);
      await playerService.updateProfile(req.playerId, body);
      dbLog.event('profile_updated', body, req.playerId);
      const doc = await playerService.get(req.playerId);
      res.json({ success: true, player: doc ? publicPlayer(doc) : null });
    }),
  );

  router.post(
    '/me/account',
    limits.account,
    asyncRoute<PlayerRequest>(async (req, res) => {
      const body = z.object({ username: z.string().max(64), password: z.string().max(64) }).parse(req.body);
      const doc = await accountService.create(req.playerId, body.username, body.password);
      res.status(201).json({ success: true, player: publicPlayer(doc) });
    }),
  );

  router.get(
    '/me/save',
    asyncRoute<PlayerRequest>(async (req, res) => {
      const save = await saveService.get(req.playerId);
      res.json({ success: true, save: save ? { rev: save.rev, keys: save.keys } : null });
    }),
  );

  router.put(
    '/me/save',
    limits.save,
    asyncRoute<PlayerRequest>(async (req, res) => {
      const body = saveSchema.parse(req.body);
      const r = await saveService.put(req.playerId, req.tokenGen, body);
      res.json({ success: true, rev: r.rev });
    }),
  );

  return router;
}
