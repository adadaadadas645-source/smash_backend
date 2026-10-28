import { Request } from 'express';
import rateLimit, { Options } from 'express-rate-limit';
import { dbLog } from '../services/logStore';
import { currentContext } from '../utils/context';
import { logSecurityEvent } from '../utils/logger';

/**
 * Limits per IP before anything else runs, and per player once the token is checked. Mobile
 * networks put many players behind one IP, so the per-IP limits are wide and the real limits
 * are per player. Counters are in memory: right for one Render instance; with several, move
 * them to Redis (rate-limit-redis) as Avenia does.
 */
const onLimit = (name: string): Options['handler'] => (req, res, _next, options) => {
  const ctx = currentContext();
  const data = { limiter: name, ip: req.ip, path: req.path, playerId: ctx?.playerId };
  logSecurityEvent('rate_limited', data);
  dbLog.security('rate_limited', data);
  res.status(options.statusCode).json({ success: false, error: 'rate_limited', message: 'Too many requests, slow down.', requestId: ctx?.requestId });
};

const byPlayer = (req: Request) => (req as Request & { playerId?: string }).playerId || `ip:${req.ip}`;

const make = (name: string, windowMs: number, limit: number, keyGenerator?: (req: Request) => string) =>
  rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator, handler: onLimit(name) });

export const limits = {
  /** Everything, per IP. */
  global: make('global', 60_000, 600),
  /** New players per IP. */
  register: make('register', 60 * 60_000, 40),
  /** Signing in again with the device secret, per IP (guessing secrets). */
  signIn: make('signIn', 15 * 60_000, 60),
  /** Per player. */
  player: make('player', 60_000, 120, byPlayer),
  leaderboardWrite: make('leaderboardWrite', 60_000, 20, byPlayer),
  purchases: make('purchases', 60_000, 30, byPlayer),
  /** Opening an account on a new device, per IP (guessing passwords; each account also locks itself). */
  recover: make('recover', 15 * 60_000, 20),
  /** Making the account, per player. */
  account: make('account', 60 * 60_000, 20, byPlayer),
  /** The cloud save, per player (the game sends it a few seconds after a change). */
  save: make('save', 60_000, 20, byPlayer),
  clientLogs: make('clientLogs', 60_000, 30, byPlayer),
  admin: make('admin', 60_000, 120),
};
