import { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { playerService } from '../services/playerService';
import { safeEqual, verifyAccessToken } from '../services/tokenService';
import { dbLog } from '../services/logStore';
import { setContextPlayer } from '../utils/context';
import { logger, logSecurityEvent } from '../utils/logger';
import { AppError } from './errorHandler';

export interface PlayerRequest extends Request {
  playerId: string;
  /** The token's session generation (AccessClaims.gen). */
  tokenGen: number;
}

/**
 * Bearer token -> the player. Answers 401 `token_expired` / `invalid_token` (the game then signs
 * in again with its device secret), 401 `player_not_found`, 401 `session_replaced` (the account
 * was opened on another device with its username and password), or 403 `player_banned`.
 */
export async function requirePlayer(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw new AppError(401, 'missing_token', 'Authorization: Bearer <token> required');

    const result = verifyAccessToken(token);
    if (!result.ok) {
      if (result.reason === 'invalid') logSecurityEvent('invalid_token', { tokenLength: token.length });
      throw new AppError(401, result.reason === 'expired' ? 'token_expired' : 'invalid_token');
    }

    const status = await playerService.status(result.playerId);
    if (!status.exists) throw new AppError(401, 'player_not_found');
    setContextPlayer(result.playerId);
    if (status.banned) {
      logSecurityEvent('banned_player_request', { playerId: result.playerId });
      throw new AppError(403, 'player_banned');
    }
    if (result.gen !== status.gen) {
      logSecurityEvent('session_replaced', { playerId: result.playerId, tokenGen: result.gen, gen: status.gen });
      throw new AppError(401, 'session_replaced');
    }
    (req as PlayerRequest).playerId = result.playerId;
    (req as PlayerRequest).tokenGen = result.gen;
    playerService.touch(result.playerId);
    logger.debug({ playerId: result.playerId }, 'Player authenticated');
    next();
  } catch (err) {
    next(err);
  }
}

/** x-admin-key for the support endpoints; off entirely while ADMIN_API_KEY is not set. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!config.adminApiKey) return next(new AppError(404, 'not_found'));
  const key = req.get('x-admin-key') || '';
  if (!key || !safeEqual(key, config.adminApiKey)) {
    logSecurityEvent('admin_key_rejected', { ip: req.ip, path: req.path });
    dbLog.security('admin_key_rejected', { ip: req.ip, path: req.path });
    return next(new AppError(401, 'invalid_admin_key'));
  }
  next();
}
