import { Router } from 'express';
import { z } from 'zod';
import { PlayerRequest, requirePlayer } from '../middleware/auth';
import { asyncRoute } from '../middleware/errorHandler';
import { limits } from '../middleware/rateLimits';
import { dbLog } from '../services/logStore';
import { createSchema, teamService } from '../services/teamService';
import { logBusinessEvent } from '../utils/logger';

/**
 * GET  /teams/mine                 -> { team, members } | { team: null }
 * GET  /teams/recommended          -> { teams }
 * GET  /teams/top?country=TR       -> { teams }          (the team board: the world's, or a country's)
 * GET  /teams/search?q=            -> { teams }
 * GET  /teams/:id                  -> { team, members }
 * POST /teams                      { name, description, crest, type, minLevel, minCrowns } -> { id }
 * POST /teams/:id/join
 * POST /teams/leave
 * GET  /teams/chat                 -> { messages, askLifeInMs, livesWaiting }
 * POST /teams/chat                 { text } -> { text }   (as stored: masked)
 * POST /teams/life/ask
 * POST /teams/life/:messageId/help -> { coins }
 * POST /teams/life/take            -> { lives }
 * POST /teams/report               { messageId, reason }
 */
const idParam = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export function createTeamRouter(): Router {
  const router = Router();
  router.use(requirePlayer, limits.player);

  router.get('/mine', asyncRoute<PlayerRequest>(async (req, res) => {
    const m = await teamService.memberOf(req.playerId);
    if (!m) return res.json({ success: true, team: null });
    res.json({ success: true, ...(await teamService.info(m.teamId)), role: m.role });
  }));
  router.get('/recommended', asyncRoute<PlayerRequest>(async (_req, res) => res.json({ success: true, teams: await teamService.recommended() })));
  router.get('/top', asyncRoute<PlayerRequest>(async (req, res) => res.json({ success: true, teams: await teamService.top(String(req.query.country ?? '').toUpperCase() || undefined) })));
  router.get('/search', limits.social, asyncRoute<PlayerRequest>(async (req, res) => res.json({ success: true, teams: await teamService.search(String(req.query.q ?? '')) })));
  router.get('/chat', asyncRoute<PlayerRequest>(async (req, res) => res.json({ success: true, ...(await teamService.messages(req.playerId)) })));

  router.post('/', limits.social, asyncRoute<PlayerRequest>(async (req, res) => {
    const r = await teamService.create(req.playerId, createSchema.parse(req.body));
    logBusinessEvent('team_created', { teamId: r.id });
    dbLog.event('team_created', { teamId: r.id });
    res.json({ success: true, ...r });
  }));
  router.post('/leave', limits.social, asyncRoute<PlayerRequest>(async (req, res) => {
    await teamService.leave(req.playerId);
    res.json({ success: true });
  }));
  router.post('/chat', limits.chat, asyncRoute<PlayerRequest>(async (req, res) => {
    const body = z.object({ text: z.string().min(1).max(500) }).parse(req.body);
    res.json({ success: true, ...(await teamService.say(req.playerId, body.text)) });
  }));
  router.post('/life/ask', limits.social, asyncRoute<PlayerRequest>(async (req, res) => {
    await teamService.askLife(req.playerId);
    res.json({ success: true });
  }));
  router.post('/life/take', limits.social, asyncRoute<PlayerRequest>(async (req, res) => res.json({ success: true, lives: await teamService.takeLives(req.playerId) })));
  router.post('/life/:messageId/help', limits.social, asyncRoute<PlayerRequest>(async (req, res) => {
    res.json({ success: true, ...(await teamService.help(req.playerId, idParam.parse(req.params.messageId))) });
  }));
  router.post('/report', limits.social, asyncRoute<PlayerRequest>(async (req, res) => {
    const body = z.object({ messageId: idParam, reason: z.string().max(40).optional().default('other') }).parse(req.body);
    await teamService.report(req.playerId, body.messageId, body.reason);
    dbLog.security('chat_report', { messageId: body.messageId, reason: body.reason });
    res.json({ success: true });
  }));
  router.get('/:id', asyncRoute<PlayerRequest>(async (req, res) => res.json({ success: true, ...(await teamService.info(idParam.parse(req.params.id))) })));
  router.post('/:id/join', limits.social, asyncRoute<PlayerRequest>(async (req, res) => {
    await teamService.join(req.playerId, idParam.parse(req.params.id));
    res.json({ success: true });
  }));
  return router;
}
