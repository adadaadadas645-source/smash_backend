import { Router } from 'express';
import { z } from 'zod';
import { PlayerRequest, requirePlayer } from '../middleware/auth';
import { asyncRoute } from '../middleware/errorHandler';
import { limits } from '../middleware/rateLimits';
import { dbLog } from '../services/logStore';
import { createSchema, editSchema, teamService } from '../services/teamService';
import { logBusinessEvent } from '../utils/logger';

/**
 * GET    /teams/mine                  -> { team, members } | { team: null }
 * PATCH  /teams/mine                  { description?, crest?, type?, minLevel?, minCrowns? } -> { team }
 * GET    /teams/recommended           -> { teams }
 * GET    /teams/top?country=TR        -> { teams }          (the team board: the world's, or a country's)
 * GET    /teams/search?q=             -> { teams }
 * GET    /teams/chat                  -> { messages, askLifeInMs, askCoinsInMs, livesWaiting, coinsWaiting }
 * POST   /teams/chat                  { text } -> { text }   (as stored: masked)
 * POST   /teams                       { name, description, crest, type, minLevel, minCrowns } -> { id }
 * POST   /teams/leave
 * POST   /teams/kick                  { playerId }
 * POST   /teams/role                  { playerId, role: leader | coleader | knight } -> { role }
 * POST   /teams/requests/cancel       -> { cancelled }
 * DELETE /teams/requests/mine         -> { cancelled }
 * POST   /teams/requests/:playerId    { accept } -> { joined }
 * POST   /teams/life/ask
 * POST   /teams/life/:messageId/help  -> { coins }
 * POST   /teams/life/take             -> { lives }
 * POST   /teams/coins/ask
 * POST   /teams/coins/:messageId/help -> { coins }  (the helper's; the asker's go to the inbox)
 * POST   /teams/coins/take            -> { coins }
 * POST   /teams/report                { messageId, reason }
 * GET    /teams/:id                   -> { team, members }
 * POST   /teams/:id/join              -> { requested }
 */
const idParam = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const playerIdBody = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

export function createTeamRouter(): Router {
  const router = Router();
  router.use(requirePlayer, limits.player);

  router.get('/mine', asyncRoute<PlayerRequest>(async (req, res) => {
    const m = await teamService.memberOf(req.playerId);
    if (!m) return res.json({ success: true, team: null });
    res.json({ success: true, ...(await teamService.info(m.teamId)), role: m.role });
  }));
  router.patch('/mine', limits.social, asyncRoute<PlayerRequest>(async (req, res) => {
    res.json({ success: true, ...(await teamService.edit(req.playerId, editSchema.parse(req.body))) });
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
  router.post('/kick', limits.social, asyncRoute<PlayerRequest>(async (req, res) => {
    const body = z.object({ playerId: playerIdBody }).parse(req.body);
    await teamService.kick(req.playerId, body.playerId);
    res.json({ success: true });
  }));
  router.post('/role', limits.social, asyncRoute<PlayerRequest>(async (req, res) => {
    const body = z.object({ playerId: playerIdBody, role: z.enum(['leader', 'coleader', 'knight']) }).parse(req.body);
    res.json({ success: true, ...(await teamService.setRole(req.playerId, body.playerId, body.role)) });
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
  router.post('/coins/ask', limits.social, asyncRoute<PlayerRequest>(async (req, res) => {
    await teamService.askCoins(req.playerId);
    res.json({ success: true });
  }));
  router.post('/coins/take', limits.social, asyncRoute<PlayerRequest>(async (req, res) => res.json({ success: true, coins: await teamService.takeCoins(req.playerId) })));
  router.post('/coins/:messageId/help', limits.social, asyncRoute<PlayerRequest>(async (req, res) => {
    res.json({ success: true, ...(await teamService.help(req.playerId, idParam.parse(req.params.messageId))) });
  }));
  router.post('/life/:messageId/help', limits.social, asyncRoute<PlayerRequest>(async (req, res) => {
    res.json({ success: true, ...(await teamService.help(req.playerId, idParam.parse(req.params.messageId))) });
  }));
  router.post('/report', limits.social, asyncRoute<PlayerRequest>(async (req, res) => {
    const body = z.object({ messageId: idParam, reason: z.string().max(40).optional().default('other') }).parse(req.body);
    await teamService.report(req.playerId, body.messageId, body.reason);
    dbLog.security('chat_report', { messageId: body.messageId, reason: body.reason });
    res.json({ success: true });
  }));
  // Keep specific /requests/* routes BEFORE /:id!
  router.post('/requests/cancel', limits.social, asyncRoute<PlayerRequest>(async (req, res) => {
    res.json({ success: true, ...(await teamService.cancelRequest(req.playerId)) });
  }));
  router.delete('/requests/mine', limits.social, asyncRoute<PlayerRequest>(async (req, res) => {
    res.json({ success: true, ...(await teamService.cancelRequest(req.playerId)) });
  }));
  router.post('/requests/:playerId', limits.social, asyncRoute<PlayerRequest>(async (req, res) => {
    const body = z.object({ accept: z.boolean() }).parse(req.body);
    res.json({ success: true, ...(await teamService.answerRequest(req.playerId, idParam.parse(req.params.playerId), body.accept)) });
  }));
  router.get('/:id', asyncRoute<PlayerRequest>(async (req, res) => res.json({ success: true, ...(await teamService.info(idParam.parse(req.params.id))) })));
  router.post('/:id/join', limits.social, asyncRoute<PlayerRequest>(async (req, res) => {
    res.json({ success: true, ...(await teamService.join(req.playerId, idParam.parse(req.params.id))) });
  }));
  return router;
}
