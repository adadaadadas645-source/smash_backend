import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { z } from 'zod';
import { col, FieldValue, Timestamp } from '../firebase';
import { AppError } from '../middleware/errorHandler';
import { currentContext } from '../utils/context';
import { logBusinessEvent, logSecurityEvent, logger } from '../utils/logger';
import { leaderboardService } from './leaderboardService';
import { dbLog } from './logStore';
import { PlayerDoc, playerService } from './playerService';
import { hashDeviceSecret } from './tokenService';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/**
 * The player's account: a username taken once for good (it is also the name on the
 * leaderboard from then on) and a password. With both, the account opens on another device
 * (POST /auth/recover): that device's secret replaces the old one, the session generation
 * goes up so the old device's tokens stop working, and the cloud save comes back with it.
 *
 * kingdom_usernames/{usernameKey} -> { playerId, username, createdAt } keeps the names unique.
 *
 * Deleting (Google Play's account deletion rule): from the game (DELETE /players/me) or from the
 * web page with the username and password (/account/delete): the player, the username, the cloud
 * save, the leaderboard row and the invite code go. The purchase records stay (the store's orders,
 * kept for refunds and fraud checks), no longer tied to a player; the request logs expire by themselves.
 */

/** 3-16 letters (any alphabet), digits, "_" and "."; no spaces. */
export const usernameSchema = z
  .string()
  .transform((v) => v.normalize('NFKC').trim())
  .pipe(z.string().regex(/^[\p{L}\p{N}_.]{3,16}$/u, 'username must be 3-16 letters, digits, "_" or "."'));

export const passwordSchema = z.string().min(4, 'password must be at least 4 characters').max(64);

/** The same username whatever its case: "Ali", "ALI" and "ali" are one. */
export const usernameKey = (username: string) => username.normalize('NFKC').toLowerCase();

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;
const KEYLEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function passwordMatches(password: string, stored: string | null | undefined): Promise<boolean> {
  const parts = (stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const want = Buffer.from(parts[2], 'base64');
  const got = await scrypt(password, salt, want.length || KEYLEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A hash to compare with when the username does not exist, so both answers take as long. */
let dummyHash: Promise<string> | null = null;

export const accountService = {
  /** Takes the username for this player, for good, with its password. */
  async create(playerId: string, rawUsername: string, password: string): Promise<PlayerDoc> {
    const username = usernameSchema.parse(rawUsername);
    passwordSchema.parse(password);
    const key = usernameKey(username);
    const passwordHash = await hashPassword(password);
    const playerRef = col.players().doc(playerId);
    const nameRef = col.usernames().doc(key);
    await col.players().firestore.runTransaction(async (tx) => {
      const [player, taken] = await Promise.all([tx.get(playerRef), tx.get(nameRef)]);
      if (!player.exists) throw new AppError(404, 'player_not_found');
      if (player.get('username')) throw new AppError(409, 'account_exists', 'This player already has a username');
      if (taken.exists) throw new AppError(409, 'username_taken', 'This username is taken');
      tx.create(nameRef, { playerId, username, createdAt: FieldValue.serverTimestamp() });
      tx.update(playerRef, { username, usernameKey: key, name: username, passwordHash, gen: player.get('gen') ?? 0, accountAt: FieldValue.serverTimestamp() });
    });
    logBusinessEvent('account_created', { playerId, username });
    dbLog.event('account_created', { username }, playerId);
    const doc = await playerService.get(playerId);
    if (!doc) throw new AppError(404, 'player_not_found');
    return doc;
  },

  /**
   * The account a username and password open, or 401 `invalid_credentials`. Wrong passwords
   * count; after five in a row the account waits 15 minutes. "No such username" and "wrong
   * password" get the same answer, in the same time. `what` names the log events.
   */
  async withPassword(rawUsername: string, password: string, what: 'recover' | 'delete'): Promise<PlayerDoc> {
    const parsed = usernameSchema.safeParse(rawUsername);
    const key = parsed.success ? usernameKey(parsed.data) : null;
    const name = key ? await col.usernames().doc(key).get() : null;
    const playerId = name?.exists ? (name.get('playerId') as string) : null;
    const doc = playerId ? await playerService.get(playerId) : null;
    const logData = { username: parsed.success ? parsed.data : String(rawUsername).slice(0, 20), playerId, ip: currentContext()?.ip };

    if (!doc || !doc.passwordHash) {
      dummyHash ??= hashPassword('not-a-password');
      await passwordMatches(password, await dummyHash);
      logSecurityEvent(`${what}_rejected`, { ...logData, found: false });
      dbLog.security(`${what}_rejected`, { ...logData, found: false });
      throw new AppError(401, 'invalid_credentials');
    }
    if (doc.lockedUntil && doc.lockedUntil.toMillis() > Date.now()) {
      logSecurityEvent(`${what}_locked`, logData);
      throw new AppError(429, 'account_locked', 'Too many wrong passwords, try again later', { retryAt: doc.lockedUntil.toDate().toISOString() });
    }
    if (!(await passwordMatches(password, doc.passwordHash))) {
      const fails = (doc.failedLogins ?? 0) + 1;
      const lock = fails >= MAX_FAILS;
      await col.players().doc(doc.playerId).update({ failedLogins: lock ? 0 : fails, lockedUntil: lock ? Timestamp.fromMillis(Date.now() + LOCK_MS) : doc.lockedUntil ?? null });
      logSecurityEvent(`${what}_rejected`, { ...logData, found: true, fails, locked: lock });
      dbLog.security(`${what}_rejected`, { ...logData, found: true, fails, locked: lock }, doc.playerId);
      throw new AppError(401, 'invalid_credentials');
    }
    return doc;
  },

  /**
   * Opens the account on this device: right username and password (withPassword), and the
   * device's secret becomes the account's.
   */
  async recover(rawUsername: string, password: string, deviceSecret: string): Promise<PlayerDoc> {
    const doc = await this.withPassword(rawUsername, password, 'recover');
    const logData = { username: doc.username, playerId: doc.playerId, ip: currentContext()?.ip };
    const ref = col.players().doc(doc.playerId);
    if (doc.banned) throw new AppError(403, 'player_banned');
    const ctx = currentContext();
    await ref.update({
      deviceSecretHash: hashDeviceSecret(deviceSecret),
      gen: FieldValue.increment(1),
      failedLogins: 0,
      lockedUntil: null,
      recoveredAt: FieldValue.serverTimestamp(),
      installId: ctx?.installId ?? null,
      platform: ctx?.platform ?? null,
      deviceModel: ctx?.deviceModel ?? null,
    });
    playerService.forgetStatus(doc.playerId);
    const fresh = await playerService.get(doc.playerId);
    if (!fresh) throw new AppError(404, 'player_not_found');
    logBusinessEvent('account_recovered', { ...logData, gen: fresh.gen });
    dbLog.event('account_recovered', { username: fresh.username, gen: fresh.gen, platform: ctx?.platform, deviceModel: ctx?.deviceModel }, doc.playerId);
    logger.info({ playerId: doc.playerId }, 'Account opened on a new device');
    return fresh;
  },

  /**
   * Deletes the player for good: the player, its username, cloud save, leaderboard row, invite
   * code and referral. The purchase records stay (see above). Its tokens stop working at once
   * (player_not_found).
   */
  async remove(playerId: string, how: 'game' | 'web'): Promise<void> {
    const doc = await playerService.get(playerId);
    if (!doc) throw new AppError(404, 'player_not_found');
    const batch = col.players().firestore.batch();
    if (doc.usernameKey) batch.delete(col.usernames().doc(doc.usernameKey));
    const inviteCode = (doc as PlayerDoc & { inviteCode?: string }).inviteCode;
    if (inviteCode) batch.delete(col.invites().doc(inviteCode));
    batch.delete(col.saves().doc(playerId));
    batch.delete(col.referrals().doc(playerId));
    batch.delete(col.players().doc(playerId));
    await batch.commit();
    await leaderboardService.remove(playerId);
    playerService.forgetStatus(playerId);
    logBusinessEvent('account_deleted', { playerId, how, hadUsername: !!doc.username });
    dbLog.event('account_deleted', { how, hadUsername: !!doc.username }, playerId);
    logger.info({ playerId, how }, 'Player deleted');
  },

  /** The web page's deletion: the username and password say whose (withPassword). */
  async removeWithPassword(rawUsername: string, password: string): Promise<void> {
    const doc = await this.withPassword(rawUsername, password, 'delete');
    await this.remove(doc.playerId, 'web');
  },
};
