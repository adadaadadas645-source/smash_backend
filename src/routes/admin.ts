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
import { seedService } from '../services/seedService';
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
 * POST   /admin/seed/teams               the sample teams for launch (services/seedService.ts; the same each time)
 * DELETE /admin/seed/teams               … all taken away again
 * GET    /admin/players/by-name?name=Polat   players with that name: id, level, hidden or not
 * POST   /admin/players/:playerId/unhide       a hidden board row shown again (strikes cleared)
 * POST   /admin/backfill/names           the name search's lowercase name on older leaderboard rows
 */
const plain = (d: FirebaseFirestore.DocumentSnapshot) => ({ id: d.id, ...(safeForLog(d.data()) as object) });

export function createAdminRouter(): Router {
  const router = Router();
  router.use(limits.admin, requireAdmin);

  router.get(
    '/players/by-name',
    asyncRoute(async (req, res) => {
      const name = z.string().min(1).max(40).parse(req.query.name);
      const [byPlayer, byBoard] = await Promise.all([
        col.players().where('name', '==', name).limit(20).get(),
        col.leaderboard().where('nameLower', '==', name.toLocaleLowerCase('tr')).limit(20).get(),
      ]);
      const ids = [...new Set([...byPlayer.docs.map((d) => d.id), ...byBoard.docs.map((d) => d.id)])];
      const rows = await Promise.all(
        ids.map(async (id) => {
          const [p, b] = await Promise.all([col.players().doc(id).get(), col.leaderboard().doc(id).get()]);
          return {
            playerId: id,
            name: p.get('name') ?? b.get('name') ?? null,
            username: p.get('username') ?? null,
            onBoard: b.exists,
            boardName: b.get('name') ?? null,
            level: b.get('level') ?? p.get('level') ?? null,
            hidden: !!b.get('hidden'),
            strikes: b.get('strikes') ?? 0,
          };
        }),
      );
      res.json({ success: true, players: rows });
    }),
  );

  router.post(
    '/players/:playerId/unhide',
    asyncRoute(async (req, res) => {
      const id = req.params.playerId;
      const ok = await leaderboardService.unhide(id);
      if (!ok) throw new AppError(404, 'not_on_board');
      logBusinessEvent('player_unhidden', { target: id });
      res.json({ success: true, playerId: id, hidden: false });
    }),
  );

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

  router.post('/seed/teams', asyncRoute(async (_req, res) => {
    const r = await seedService.plant();
    logBusinessEvent('seed_teams', r);
    res.json({ success: true, ...r });
  }));
  router.delete('/seed/teams', asyncRoute(async (_req, res) => res.json({ success: true, ...(await seedService.remove()) })));
  router.post('/backfill/names', asyncRoute(async (_req, res) => res.json({ success: true, ...(await seedService.backfillNames()) })));

  return router;
}
