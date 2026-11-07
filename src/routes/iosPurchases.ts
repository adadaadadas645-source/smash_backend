import { Router } from 'express';
import { z } from 'zod';
import { PlayerRequest, requirePlayer } from '../middleware/auth';
import { asyncRoute } from '../middleware/errorHandler';
import { limits } from '../middleware/rateLimits';
import { iosPurchaseService } from '../services/iosPurchaseService';

/**
 * POST /purchases/ios/verify  { productId?, receipt? | transactionId? }
 *   -> { status: granted | already_granted | rejected, grant, productId, transactionId, ... }
 *
 * The App Store's own endpoint, apart from Google Play's /purchases/verify. receipt is Unity
 * IAP's App Store receipt ({ Store: "AppleAppStore", TransactionID, Payload }); transactionId
 * may be sent on its own instead. granted / already_granted: the game hands the product over
 * (unless it already did for this transaction) and finishes the transaction. rejected: it
 * finishes it without handing over. Any 5xx: it keeps the transaction open and asks again later.
 */
const verifySchema = z
  .object({
    productId: z.string().max(64).optional(),
    receipt: z.string().min(20).max(200_000).optional(),
    transactionId: z.string().regex(/^\d{1,32}$/).optional(),
  })
  .refine((b) => !!b.receipt || !!b.transactionId, { message: 'receipt or transactionId is required' });

export function createIosPurchaseRouter(): Router {
  const router = Router();
  router.use(requirePlayer, limits.purchases);

  router.post(
    '/verify',
    asyncRoute<PlayerRequest>(async (req, res) => {
      const body = verifySchema.parse(req.body);
      const a = await iosPurchaseService.verify(req.playerId, body);
      res.json({
        success: true,
        store: 'app_store',
        status: a.status,
        grant: a.grant,
        productId: a.productId,
        transactionId: a.transactionId,
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
