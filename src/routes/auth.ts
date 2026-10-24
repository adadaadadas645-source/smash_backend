import { Router } from 'express';
import { z } from 'zod';
import { AppError, asyncRoute } from '../middleware/errorHandler';
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
 *
 * The device secret is 64 hex characters the game makes once with a secure random generator.
 */
const secret = z.string().regex(/^[a-f0-9]{64}$/, 'deviceSecret must be 64 lowercase hex characters');

const registerSchema = profileSchema.extend({ deviceSecret: secret });
const tokenSchema = z.object({ playerId: z.string().regex(/^p_[A-Za-z0-9_-]{10,40}$/), deviceSecret: secret });

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
        name: body.name ?? `Oyuncu${1000 + Math.floor(Math.random() * 9000)}`,
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
      // The same answer for "no such player" and "wrong secret", so ids cannot be probed.
      if (!doc || !deviceSecretMatches(body.deviceSecret, doc.deviceSecretHash)) {
        logSecurityEvent('sign_in_rejected', { playerId: body.playerId, found: !!doc });
        dbLog.security('sign_in_rejected', { found: !!doc }, body.playerId);
        throw new AppError(401, 'invalid_credentials');
      }
      if (doc.banned) throw new AppError(403, 'player_banned');
      const { token, expiresAt } = issueAccessToken(doc.playerId);
      playerService.touch(doc.playerId);
      logger.info({ playerId: doc.playerId }, 'Player signed in again');
      dbLog.event('player_signed_in', undefined, doc.playerId);
      res.json({ success: true, playerId: doc.playerId, token, expiresAt, player: publicPlayer(doc) });
    }),
  );

  return router;
}
