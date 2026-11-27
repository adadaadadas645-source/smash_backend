import { Router } from 'express';
import { z } from 'zod';
import { PlayerRequest, requirePlayer } from '../middleware/auth';
import { asyncRoute } from '../middleware/errorHandler';
import { limits } from '../middleware/rateLimits';
import { directMessageService } from '../services/directMessageService';

/**
 * Direct messages between two players (services/directMessageService.ts):
 *
 * GET  /dm/inbox?since=ms&teamSeen=ms -> { now, requests: [{ playerId, name, at }], messages: [{ playerId, name, text, at }],
 *                                      friendRequestsAt: [ms], teamUnread, teamLastAt }
 * GET  /dm/search?name=Player43       -> { players: [{ playerId, name, avatar, frame, level, team, stats }] }
 * GET  /dm/find/:code                 -> { player: { playerId, code, name, avatar, frame, level, team, stats, friend } }
 * GET  /dm/:playerId                  -> { other, messages, livesWaiting, coinsWaiting, askLifeInMs, askCoinsInMs }
 * POST /dm/:playerId        { text }  -> { ok }
 * POST /dm/:playerId/ask    { kind: life | coins } -> { ok }   (429 ask_too_soon)
 * POST /dm/:playerId/help   { messageId }          -> { sent, n }
 * POST /dm/:playerId/take                           -> { lives, coins }
 */
const playerId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

export function createDirectMessageRouter(): Router {
  const router = Router();
  router.use(requirePlayer, limits.player);

  router.get('/inbox', asyncRoute<PlayerRequest>(async (req, res) => res.json({ success: true, ...(await directMessageService.inbox(req.playerId, Number(req.query.since ?? 0), Number(req.query.teamSeen ?? 0))) })));
  router.get('/search', limits.social, asyncRoute<PlayerRequest>(async (req, res) => res.json({ success: true, ...(await directMessageService.search(req.playerId, String(req.query.name ?? ''))) })));
  router.get('/find/:code', limits.social, asyncRoute<PlayerRequest>(async (req, res) => res.json({ success: true, ...(await directMessageService.find(req.playerId, String(req.params.code))) })));
  router.get('/:other', asyncRoute<PlayerRequest>(async (req, res) => res.json({ success: true, ...(await directMessageService.read(req.playerId, playerId.parse(req.params.other))) })));
  router.post(
    '/:other',
    limits.chat,
    asyncRoute<PlayerRequest>(async (req, res) => {
      const body = z.object({ text: z.string().min(1).max(200) }).parse(req.body);
      res.json({ success: true, ...(await directMessageService.say(req.playerId, playerId.parse(req.params.other), body.text)) });
    }),
  );
  router.post(
    '/:other/ask',
    limits.social,
    asyncRoute<PlayerRequest>(async (req, res) => {
      const body = z.object({ kind: z.enum(['life', 'coins']) }).parse(req.body);
      res.json({ success: true, ...(await directMessageService.ask(req.playerId, playerId.parse(req.params.other), body.kind)) });
    }),
  );
  router.post(
    '/:other/help',
    limits.social,
    asyncRoute<PlayerRequest>(async (req, res) => {
      const body = z.object({ messageId: z.string().min(1).max(64) }).parse(req.body);
      res.json({ success: true, ...(await directMessageService.help(req.playerId, playerId.parse(req.params.other), body.messageId)) });
    }),
  );
  router.post('/:other/take', limits.social, asyncRoute<PlayerRequest>(async (req, res) => res.json({ success: true, ...(await directMessageService.take(req.playerId, playerId.parse(req.params.other))) })));

  return router;
}
