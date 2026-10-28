import { Router } from 'express';
import { z } from 'zod';
import { AppError, asyncRoute } from '../middleware/errorHandler';
import { accountService } from '../services/accountService';
import { saveService } from '../services/saveService';
import { limits } from '../middleware/rateLimits';
import { dbLog } from '../services/logStore';
import { playerService, publicPlayer } from '../services/playerService';
import { profileSchema } from '../services/profile';
import { deviceSecretMatches, hashDeviceSecret, issueAccessToken, newPlayerId } from '../services/tokenService';
import { setContextPlayer } from '../utils/context';
import { logBusinessEvent, logger, logSecurityEvent } from '../utils/logger';

/**
 * POST /auth/register  { deviceSecret, name?, avatar?, frame?, locale? } -> { playerId, token, expiresAt, player }
 * POST /auth/token     { playerId, deviceSecret }                       -> { playerId, token, expiresAt, player }
 * POST /auth/recover   { username, password, deviceSecret }             -> { playerId, token, expiresAt, player, save }
 *   (the account opened on a new device: this device's secret becomes the account's, the old
 *   device's tokens stop working, and the cloud save comes back: { rev, keys } or null)
 *
 * The device secret is 64 hex characters the game makes once with a secure random generator.
 */
const secret = z.string().regex(/^[a-f0-9]{64}$/, 'deviceSecret must be 64 lowercase hex characters');

const registerSchema = profileSchema.extend({ deviceSecret: secret });
const tokenSchema = z.object({ playerId: z.string().regex(/^p_[A-Za-z0-9_-]{10,40}$/), deviceSecret: secret });
const recoverSchema = z.object({ username: z.string().max(64), password: z.string().max(64), deviceSecret: secret });

export function createAuthRouter(): Router {
  const router = Router();

  router.post(
    '/register',
    limits.register,
    asyncRoute(async (req, res) => {
      const body = registerSchema.parse(req.body);
      const playerId = newPlayerId();
      setContextPlayer(playerId);
      const doc = await playerService.create(playerId, hashDeviceSecret(body.deviceSecret), {
        name: body.name ?? `Player${1000 + Math.floor(Math.random() * 9000)}`,
        avatar: body.avatar ?? 'leo',
        frame: body.frame ?? 'gold',
        locale: body.locale,
      });
      const { token, expiresAt } = issueAccessToken(playerId);
      logBusinessEvent('player_registered', { playerId, name: doc.name });
      dbLog.event('player_registered', { name: doc.name, avatar: doc.avatar, locale: doc.locale }, playerId);
      res.status(201).json({ success: true, playerId, token, expiresAt, player: publicPlayer(doc) });
    }),
  );

  router.post(
    '/token',
    limits.signIn,
    asyncRoute(async (req, res) => {
      const body = tokenSchema.parse(req.body);
      setContextPlayer(body.playerId);
      const doc = await playerService.get(body.playerId);
      if (!doc || !deviceSecretMatches(body.deviceSecret, doc.deviceSecretHash)) {
        logSecurityEvent('sign_in_rejected', { playerId: body.playerId, found: !!doc });
        dbLog.security('sign_in_rejected', { found: !!doc }, body.playerId);
        // Only POST /auth/recover changes a player's secret: the account was opened on another
        // device with its username and password, and this one must not go on as a new player
        // with the same coins. (Player ids are unguessable, so this tells a prober nothing.)
        if (doc && (doc.gen ?? 0) > 0) throw new AppError(401, 'session_replaced');
        throw new AppError(401, 'invalid_credentials');
      }
      if (doc.banned) throw new AppError(403, 'player_banned');
      const { token, expiresAt } = issueAccessToken(doc.playerId, doc.gen ?? 0);
      playerService.touch(doc.playerId);
      logger.info({ playerId: doc.playerId }, 'Player signed in again');
      dbLog.event('player_signed_in', undefined, doc.playerId);
      res.json({ success: true, playerId: doc.playerId, token, expiresAt, player: publicPlayer(doc) });
    }),
  );

  router.post(
    '/recover',
    limits.recover,
    asyncRoute(async (req, res) => {
      const body = recoverSchema.parse(req.body);
      const doc = await accountService.recover(body.username, body.password, body.deviceSecret);
      setContextPlayer(doc.playerId);
      const { token, expiresAt } = issueAccessToken(doc.playerId, doc.gen ?? 0);
      const save = await saveService.get(doc.playerId);
      res.json({ success: true, playerId: doc.playerId, token, expiresAt, player: publicPlayer(doc), save: save ? { rev: save.rev, keys: save.keys } : null });
    }),
  );

  return router;
}
