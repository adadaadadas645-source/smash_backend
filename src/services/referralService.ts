import { randomInt } from 'crypto';
import { col, FieldValue } from '../firebase';
import { AppError } from '../middleware/errorHandler';
import { currentContext } from '../utils/context';
import { logBusinessEvent, logSecurityEvent } from '../utils/logger';
import { dbLog } from './logStore';

/**
 * Invite Friends. Each player has an invite code (made the first time it is asked for), shared
 * as a Play Store link whose install referrer carries it. A new player's game reads it on its
 * first launch and joins with it (POST /referrals/join): the friend gets a welcome gift, and
 * the inviter counts one more friend. The friend counts toward the inviter's rewards once they
 * reach level QUALIFY_LEVEL (the leaderboard's checked level, onLevel); every FRIENDS_PER_REWARD
 * of those pays REWARD_COINS, taken with POST /referrals/reward.
 *
 * kingdom_invites/{code}       -> { playerId }                 (codes are unique)
 * kingdom_referrals/{friendId} -> { inviter, friend, joinedAt, qualified, qualifiedAt }
 * kingdom_players/{id}           inviteCode, invitedBy, invitesJoined, invitesQualified, inviteRewards
 */
export const QUALIFY_LEVEL = 20;
export const FRIENDS_PER_REWARD = 2;
export const REWARD_COINS = 1000;
export const WELCOME_COINS = 500;
/** A code is taken only by a player this new (it is for new installs). */
const JOIN_WITHIN_MS = 7 * 86400_000;
/** No inviter gains more than this many friends a day (a farm of fake installs). */
const JOINS_PER_DAY = 30;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const normalizeCode = (raw: string) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

function newCode(): string {
  let s = '';
  for (let i = 0; i < 7; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

export interface ReferralStatus {
  code: string;
  joined: number;
  qualified: number;
  rewarded: number;
  claimable: number;
  perReward: number;
  rewardCoins: number;
  qualifyLevel: number;
  invitedBy: boolean;
}

/** Rewards earned by `qualified` friends and not yet taken. */
export const claimableRewards = (qualified: number, rewarded: number) => Math.max(0, Math.floor(qualified / FRIENDS_PER_REWARD) - rewarded);

export const referralService = {
  /** The player's code, made (and reserved) the first time. */
  async codeOf(playerId: string): Promise<string> {
    const ref = col.players().doc(playerId);
    const snap = await ref.get();
    if (!snap.exists) throw new AppError(404, 'player_not_found');
    const have = snap.get('inviteCode') as string | undefined;
    if (have) return have;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode();
      try {
        await col.players().firestore.runTransaction(async (tx) => {
          const again = await tx.get(ref);
          if (again.get('inviteCode')) throw new AppError(409, 'has_code');
          tx.create(col.invites().doc(code), { playerId, createdAt: FieldValue.serverTimestamp() });
          tx.update(ref, { inviteCode: code });
        });
        return code;
      } catch (err) {
        if (err instanceof AppError && err.code === 'has_code') return (await ref.get()).get('inviteCode') as string;
        // ALREADY_EXISTS: the code is someone else's, try another.
        if ((err as { code?: number }).code !== 6) throw err;
      }
    }
    throw new AppError(503, 'no_code', 'Could not make an invite code, try again');
  },

  async status(playerId: string): Promise<ReferralStatus> {
    const code = await this.codeOf(playerId);
    const snap = await col.players().doc(playerId).get();
    const qualified = (snap.get('invitesQualified') as number | undefined) ?? 0;
    const rewarded = (snap.get('inviteRewards') as number | undefined) ?? 0;
    return {
      code,
      joined: (snap.get('invitesJoined') as number | undefined) ?? 0,
      qualified,
      rewarded,
      claimable: claimableRewards(qualified, rewarded),
      perReward: FRIENDS_PER_REWARD,
      rewardCoins: REWARD_COINS,
      qualifyLevel: QUALIFY_LEVEL,
      invitedBy: !!snap.get('invitedBy'),
    };
  },

  /** A new player joins with a friend's code; answers the welcome gift (coins). */
  async join(playerId: string, rawCode: string): Promise<{ coins: number }> {
    const code = normalizeCode(rawCode);
    if (code.length < 5) throw new AppError(400, 'invalid_code');
    const owner = await col.invites().doc(code).get();
    if (!owner.exists) throw new AppError(404, 'unknown_code');
    const inviter = owner.get('playerId') as string;
    if (inviter === playerId) throw new AppError(400, 'own_code');
    const ctx = currentContext();
    const meRef = col.players().doc(playerId);
    const inviterRef = col.players().doc(inviter);
    const refRef = col.referrals().doc(playerId);
    await col.players().firestore.runTransaction(async (tx) => {
      const [me, them, seen] = await Promise.all([tx.get(meRef), tx.get(inviterRef), tx.get(refRef)]);
      if (!me.exists || !them.exists) throw new AppError(404, 'player_not_found');
      if (me.get('invitedBy') || seen.exists) throw new AppError(409, 'already_joined');
      const created = (me.get('createdAt') as FirebaseFirestore.Timestamp | undefined)?.toMillis() ?? 0;
      if (Date.now() - created > JOIN_WITHIN_MS) throw new AppError(400, 'too_late', 'Invite codes are for new players');
      // The same install as the inviter: one person inviting themself.
      const myInstall = me.get('installId') as string | undefined;
      if (myInstall && myInstall === them.get('installId')) throw new AppError(400, 'own_code');
      const today = new Date().toISOString().slice(0, 10);
      const day = them.get('inviteDay') === today ? ((them.get('inviteDayCount') as number | undefined) ?? 0) : 0;
      if (day >= JOINS_PER_DAY) throw new AppError(429, 'inviter_limit');
      tx.create(refRef, { inviter, friend: playerId, code, joinedAt: FieldValue.serverTimestamp(), qualified: false, ip: ctx?.ip ?? null, installId: ctx?.installId ?? null });
      tx.update(meRef, { invitedBy: inviter, invitedAt: FieldValue.serverTimestamp() });
      tx.update(inviterRef, { invitesJoined: FieldValue.increment(1), inviteDay: today, inviteDayCount: day + 1 });
    });
    logBusinessEvent('referral_joined', { playerId, inviter, code });
    dbLog.event('referral_joined', { inviter, code }, playerId);
    return { coins: WELCOME_COINS };
  },

  /** The leaderboard took a level: a friend reaching QUALIFY_LEVEL counts for their inviter, once. */
  async onLevel(playerId: string, level: number): Promise<void> {
    if (level < QUALIFY_LEVEL) return;
    const refRef = col.referrals().doc(playerId);
    const counted = await col.players().firestore.runTransaction(async (tx) => {
      const r = await tx.get(refRef);
      if (!r.exists || r.get('qualified')) return null;
      const inviter = r.get('inviter') as string;
      tx.update(refRef, { qualified: true, qualifiedAt: FieldValue.serverTimestamp(), qualifiedLevel: level });
      tx.update(col.players().doc(inviter), { invitesQualified: FieldValue.increment(1) });
      return inviter;
    });
    if (counted) {
      logBusinessEvent('referral_qualified', { playerId, inviter: counted, level });
      dbLog.event('referral_qualified', { inviter: counted, level }, playerId);
    }
  },

  /** Takes one earned reward; answers its coins. */
  async reward(playerId: string): Promise<{ coins: number; status: ReferralStatus }> {
    const ref = col.players().doc(playerId);
    await col.players().firestore.runTransaction(async (tx) => {
      const me = await tx.get(ref);
      const qualified = (me.get('invitesQualified') as number | undefined) ?? 0;
      const rewarded = (me.get('inviteRewards') as number | undefined) ?? 0;
      if (claimableRewards(qualified, rewarded) <= 0) {
        logSecurityEvent('referral_reward_refused', { playerId, qualified, rewarded });
        throw new AppError(409, 'nothing_to_claim');
      }
      tx.update(ref, { inviteRewards: rewarded + 1, inviteRewardAt: FieldValue.serverTimestamp() });
    });
    logBusinessEvent('referral_reward', { playerId, coins: REWARD_COINS });
    dbLog.event('referral_reward', { coins: REWARD_COINS }, playerId);
    return { coins: REWARD_COINS, status: await this.status(playerId) };
  },
};
