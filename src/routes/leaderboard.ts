import { Router } from 'express';
import { z } from 'zod';
import { PlayerRequest, requirePlayer } from '../middleware/auth';
import { asyncRoute } from '../middleware/errorHandler';
import { limits } from '../middleware/rateLimits';
import { leaderboardService } from '../services/leaderboardService';
import { dbLog } from '../services/logStore';
import { playerService } from '../services/playerService';
import { profileSchema } from '../services/profile';
import { socialService } from '../services/socialService';
import { teamService } from '../services/teamService';
import { logBusinessEvent, logger, logSecurityEvent } from '../utils/logger';

/**
 * POST /leaderboard/level  { level, name?, avatar?, frame? } -> { level, accepted, rank }
 * GET  /leaderboard/world                                    -> { top: [...], me: {rank, level}, total }
 */
const submitSchema = profileSchema.extend({ level: z.number().int().min(1).max(100000) });

export function createLeaderboardRouter(): Router {
  const router = Router();
  router.use(requirePlayer, limits.player);

  router.post(
    '/level',
    limits.leaderboardWrite,
    asyncRoute<PlayerRequest>(async (req, res) => {
      const body = submitSchema.parse(req.body);
      let { name, avatar, frame } = body;
      if (name === undefined || avatar === undefined || frame === undefined) {
        const p = await playerService.get(req.playerId);
        name ??= p?.name ?? 'Player';
        avatar ??= (p?.avatar as typeof avatar) ?? 'leo';
        frame ??= (p?.frame as typeof frame) ?? 'gold';
      }
      const r = await leaderboardService.submit(req.playerId, body.level, { name, avatar: avatar!, frame: frame! });
      if (r.clamped || (r.first && r.level >= 150)) {
        const data = { claimed: body.level, granted: r.level, previous: r.previous, first: r.first };
        logSecurityEvent('leaderboard_suspect', data);
        dbLog.security('leaderboard_suspect', data);
      }
      if (r.accepted) {
        // The week's points (levels gained, not a first claim of old levels), the country, the team's score.
        const gained = r.previous === null ? 0 : r.level - r.previous;
        // The country: the device's region the game sends ("en-TR"), else the player's saved locale.
        void (body.locale ? Promise.resolve({ locale: body.locale }) : playerService.get(req.playerId))
          .then((p) => socialService.onLevel(req.playerId, gained, { name: name!, avatar: avatar!, frame: frame!, level: r.level, locale: p?.locale }))
          .catch((err) => logger.warn({ err }, 'social: level not counted'));
        void teamService.onLevel(req.playerId, r.level).catch((err) => logger.warn({ err }, 'team: level not counted'));
        logBusinessEvent('level_reached', { level: r.level, previous: r.previous, claimed: body.level });
        dbLog.event('level_reached', { level: r.level, previous: r.previous, claimed: body.level });
      }
      res.json({ success: true, level: r.level, accepted: r.accepted, clamped: r.clamped });
    }),
  );

  router.get(
    '/world',
    asyncRoute<PlayerRequest>(async (req, res) => {
      const [top, me, total] = await Promise.all([leaderboardService.top(), leaderboardService.rankOf(req.playerId), leaderboardService.total()]);
      const rows = top.rows.map(({ playerId, ...row }) => (playerId === req.playerId ? { ...row, me: true } : row));
      // In the list: its place there is the truth (the count may be a few seconds older).
      const inList = rows.find((r) => r.me);
      res.set('Cache-Control', 'private, max-age=15');
      res.json({
        success: true,
        top: rows,
        me: inList ? { rank: inList.rank, level: inList.level } : me,
        // The count is up to a minute old: never fewer than the board itself shows.
        total: Math.max(total, rows.length, inList?.rank ?? me?.rank ?? 0),
        updatedAt: top.at,
      });
    }),
  );

  return router;
}
