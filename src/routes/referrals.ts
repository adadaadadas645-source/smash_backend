import { Router } from 'express';
import { z } from 'zod';
import { PlayerRequest, requirePlayer } from '../middleware/auth';
import { asyncRoute } from '../middleware/errorHandler';
import { limits } from '../middleware/rateLimits';
import { referralService } from '../services/referralService';

/**
 * GET  /referrals/me      -> { status: { code, joined, qualified, rewarded, claimable, perReward, rewardCoins, qualifyLevel, invitedBy } }
 * POST /referrals/join    { code } -> { coins }   (a new player, once: 404 unknown_code, 409 already_joined, 400 too_late / own_code)
 * POST /referrals/reward  -> { coins, status }    (409 nothing_to_claim)
 */
export function createReferralRouter(): Router {
  const router = Router();
  router.use(requirePlayer, limits.player);

  router.get(
    '/me',
    asyncRoute<PlayerRequest>(async (req, res) => {
      res.json({ success: true, status: await referralService.status(req.playerId) });
    }),
  );

  router.post(
    '/join',
    limits.account,
    asyncRoute<PlayerRequest>(async (req, res) => {
      const body = z.object({ code: z.string().max(32) }).parse(req.body);
      const r = await referralService.join(req.playerId, body.code);
      res.json({ success: true, coins: r.coins });
    }),
  );

  router.post(
    '/reward',
    limits.account,
    asyncRoute<PlayerRequest>(async (req, res) => {
      const r = await referralService.reward(req.playerId);
      res.json({ success: true, coins: r.coins, status: r.status });
    }),
  );

  return router;
}
