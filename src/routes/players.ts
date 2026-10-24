import { Router } from 'express';
import { PlayerRequest, requirePlayer } from '../middleware/auth';
import { AppError, asyncRoute } from '../middleware/errorHandler';
import { limits } from '../middleware/rateLimits';
import { dbLog } from '../services/logStore';
import { playerService, publicPlayer } from '../services/playerService';
import { profileSchema } from '../services/profile';

/**
 * GET   /players/me  -> { player }  (what was bought for good comes back from here: noAdsForever)
 * PATCH /players/me  { name?, avatar?, frame?, locale? } -> { player }
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

  return router;
}
