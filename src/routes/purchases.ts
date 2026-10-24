import { Router } from 'express';
import { z } from 'zod';
import { PlayerRequest, requirePlayer } from '../middleware/auth';
import { asyncRoute } from '../middleware/errorHandler';
import { limits } from '../middleware/rateLimits';
import { purchaseService } from '../services/purchaseService';

/**
 * POST /purchases/verify  { productId, receipt }
 *   -> { status: granted | already_granted | pending | rejected, grant, productId, orderId, ... }
 *
 * granted / already_granted: the game hands the product over (unless it already did for this
 * tokenHash) and confirms the purchase to the store. rejected: it confirms without handing
 * over. pending, or any 5xx: it keeps the purchase open and asks again later.
 */
const verifySchema = z.object({
  productId: z.string().max(64).optional(),
  receipt: z.string().min(20).max(20000),
});

export function createPurchaseRouter(): Router {
  const router = Router();
  router.use(requirePlayer, limits.purchases);

  router.post(
    '/verify',
    asyncRoute<PlayerRequest>(async (req, res) => {
      const body = verifySchema.parse(req.body);
      const a = await purchaseService.verify(req.playerId, body);
      res.json({
        success: true,
        status: a.status,
        grant: a.grant,
        productId: a.productId,
        orderId: a.orderId,
        tokenHash: a.tokenHash,
        environment: a.environment,
        verifiedBy: a.verifiedBy,
        reason: a.reason,
        contents: a.product
          ? { coins: a.product.coins, heartsMin: a.product.heartsMin, noAdsMin: a.product.noAdsMin, giant: a.product.giant, bombs: a.product.bombs }
          : null,
      });
    }),
  );

  return router;
}
