import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth';
import { AppError, asyncRoute } from '../middleware/errorHandler';
import { limits } from '../middleware/rateLimits';
import { col } from '../firebase';
import { leaderboardService } from '../services/leaderboardService';
import { dbLog } from '../services/logStore';
import { playerService } from '../services/playerService';
import { hashToken } from '../services/purchaseService';
import { logBusinessEvent } from '../utils/logger';
import { safeForLog } from '../utils/safeLog';

/**
 * Support, behind the x-admin-key header (off while ADMIN_API_KEY is not set):
 *
 * GET  /admin/players/:playerId          the player, their leaderboard row, purchases and last 100 log rows
 * GET  /admin/purchases?orderId=GPA.…    a purchase by Google's order number (from the player's e-mail)
 * GET  /admin/purchases?token=…          … or by its purchase token
 * GET  /admin/logs?playerId=&requestId=&kind=&name=&limit=   log rows, newest first
 * POST /admin/players/:playerId/ban      { banned: true, reason }  (also takes them off the board)
 */
const plain = (d: FirebaseFirestore.DocumentSnapshot) => ({ id: d.id, ...(safeForLog(d.data()) as object) });

export function createAdminRouter(): Router {
  const router = Router();
  router.use(limits.admin, requireAdmin);

  router.get(
    '/players/:playerId',
    asyncRoute(async (req, res) => {
      const id = req.params.playerId;
      const [player, board, purchases, logs] = await Promise.all([
        col.players().doc(id).get(),
        col.leaderboard().doc(id).get(),
        col.purchases().where('owners', 'array-contains', id).limit(100).get(),
        col.logs().where('playerId', '==', id).orderBy('at', 'desc').limit(100).get(),
      ]);
      if (!player.exists) throw new AppError(404, 'player_not_found');
      const p = plain(player) as Record<string, unknown>;
      delete p.deviceSecretHash;
      res.json({
        success: true,
        player: p,
        leaderboard: board.exists ? plain(board) : null,
        rank: board.exists ? await leaderboardService.rankOf(id) : null,
        purchases: purchases.docs.map(plain),
        logs: logs.docs.map(plain),
      });
    }),
  );

  router.get(
    '/purchases',
    asyncRoute(async (req, res) => {
      const q = z.object({ orderId: z.string().max(80).optional(), token: z.string().max(4000).optional() }).parse(req.query);
      if (q.token) {
        const d = await col.purchases().doc(hashToken(q.token)).get();
        res.json({ success: true, purchases: d.exists ? [plain(d)] : [] });
        return;
      }
      if (!q.orderId) throw new AppError(400, 'orderId_or_token_required');
      const snap = await col.purchases().where('orderId', '==', q.orderId).limit(10).get();
      res.json({ success: true, purchases: snap.docs.map(plain) });
    }),
  );

  router.get(
    '/logs',
    asyncRoute(async (req, res) => {
      const q = z
        .object({
          playerId: z.string().max(60).optional(),
          requestId: z.string().max(80).optional(),
          kind: z.enum(['request', 'event', 'security', 'error', 'client']).optional(),
          name: z.string().max(80).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        })
        .parse(req.query);
      let query: FirebaseFirestore.Query = col.logs();
      if (q.playerId) query = query.where('playerId', '==', q.playerId);
      if (q.requestId) query = query.where('requestId', '==', q.requestId);
      if (q.kind) query = query.where('kind', '==', q.kind);
      if (q.name) query = query.where('name', '==', q.name);
      const snap = await query.orderBy('at', 'desc').limit(q.limit).get();
      res.json({ success: true, count: snap.size, logs: snap.docs.map(plain) });
    }),
  );

  router.post(
    '/players/:playerId/ban',
    asyncRoute(async (req, res) => {
      const body = z.object({ banned: z.boolean(), reason: z.string().max(200).optional() }).parse(req.body);
      const id = req.params.playerId;
      const exists = (await col.players().doc(id).get()).exists;
      if (!exists) throw new AppError(404, 'player_not_found');
      await playerService.setBanned(id, body.banned, body.reason ?? null);
      if (body.banned) await leaderboardService.remove(id);
      logBusinessEvent(body.banned ? 'player_banned' : 'player_unbanned', { target: id, reason: body.reason });
      dbLog.event(body.banned ? 'player_banned' : 'player_unbanned', { reason: body.reason }, id);
      res.json({ success: true, playerId: id, banned: body.banned });
    }),
  );

  return router;
}
