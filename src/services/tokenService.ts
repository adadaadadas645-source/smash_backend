import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';

/**
 * The game has no sign-in: each install makes a random device secret once (kept in its own
 * save, which Android's backup brings back on a new phone) and trades it here for a player id
 * and a signed access token. Only a keyed hash of the secret is stored, so a copy of the
 * database does not let anyone sign in as a player.
 */
export interface AccessClaims {
  sub: string;
  typ: 'player';
}

export function newPlayerId(): string {
  // "p_" + 20 url-safe characters: short in logs, unguessable.
  return `p_${randomBytes(15).toString('base64url')}`;
}

export function hashDeviceSecret(secret: string): string {
  return createHmac('sha256', config.deviceSecretPepper).update(secret).digest('hex');
}

export function deviceSecretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashDeviceSecret(secret), 'hex');
  const b = Buffer.from(storedHash || '', 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function issueAccessToken(playerId: string): { token: string; expiresAt: string } {
  const ttlSeconds = config.jwt.ttlDays * 86400;
  const token = jwt.sign({ typ: 'player' } satisfies Omit<AccessClaims, 'sub'>, config.jwt.secret, {
    algorithm: 'HS256',
    subject: playerId,
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
    expiresIn: ttlSeconds,
    jwtid: randomUUID(),
  });
  return { token, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
}

export type VerifyResult = { ok: true; playerId: string } | { ok: false; reason: 'expired' | 'invalid' };

export function verifyAccessToken(token: string): VerifyResult {
  try {
    const decoded = jwt.verify(token, config.jwt.secret, {
      algorithms: ['HS256'],
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    }) as jwt.JwtPayload;
    if (decoded.typ !== 'player' || typeof decoded.sub !== 'string') return { ok: false, reason: 'invalid' };
    return { ok: true, playerId: decoded.sub };
  } catch (err) {
    return { ok: false, reason: (err as Error).name === 'TokenExpiredError' ? 'expired' : 'invalid' };
  }
}

/** Constant-time comparison for shared secrets (the admin key). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
