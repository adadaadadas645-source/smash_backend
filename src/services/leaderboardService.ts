import { config } from '../config';
import { Stats } from './profile';
import { col, FieldValue, Timestamp } from '../firebase';
import { TtlCache } from '../utils/ttlCache';
import { logger } from '../utils/logger';
import { referralService } from './referralService';

/**
 * The world leaderboard: kingdom_leaderboard/{playerId}, a collection of its own that holds only
 * what the board shows (level, name, avatar, frame) and when the level was reached (earlier
 * first on the same level).
 *
 * Reads never go to Firestore per player: the top list is one query shared by everyone for
 * LEADERBOARD_CACHE_SECONDS, and a player's own rank (two count() aggregations, cheap) is kept
 * for the same time.
 *
 * Writes only go up, and only as fast as levels can be played: from the last accepted level, a
 * few levels plus one per SECONDS_PER_LEVEL since, never more than MAX_STEP at once (time away
 * does not bank levels). A claim beyond that is cut to it, never taken as is. The first claim of
 * a player is taken (players already had their levels before the board existed) but marked when
 * it is high: such a row is hidden at once (a reinstalled, edited game starting over).
 *
 * A claim far beyond what could be played (SUSPECT_MARGIN over the ceiling), a high first claim,
 * or a save richer than any player could be (saveService) counts against the player; after
 * HIDE_AFTER of them the row is `hidden`: kept (so a later claim is not a "first" one again) and
 * shown to its own player as before, but left out of everyone else's boards (the world's, the
 * country's, the week's) and of the team's score.
 */
export interface BoardEntry {
  playerId: string;
  name: string;
  avatar: string;
  frame: string;
  level: number;
  levelReachedAt: FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.Timestamp;
  suspectCount?: number;
  /** Claims far over what could be played (claimSuspect), and flag()s; HIDE_AFTER of them hide the row. */
  strikes?: number;
  /** Left out of the boards others see (HIDE_AFTER strikes, or flag()). */
  hidden?: boolean;
}

export interface BoardRowOut {
  rank: number;
  name: string;
  avatar: string;
  frame: string;
  level: number;
  /** The player's team, when in one. */
  team?: string;
  /** The profile's numbers, for the player's card. */
  stats?: Stats;
  me?: boolean;
  /** Left out of the others' boards (never sent: topFor drops it). */
  hidden?: boolean;
}

export const SECONDS_PER_LEVEL = 15;
export const FREE_LEVELS = 3;
export const FIRST_CLAIM_FLAG = 150;
/** The most levels one claim can add, however long since the last (no banking of time away). */
export const MAX_STEP = 30;
/** How far over the ceiling a claim must be to count against the player (a little over is a slow clock, a played-offline run). */
export const SUSPECT_MARGIN = 25;
/** Suspect claims after which the row is hidden from the others' boards. */
export const HIDE_AFTER = 3;

/** The highest level the server takes now, given the last accepted one and when it came. */
export function allowedLevel(prevLevel: number | null, prevAtMs: number | null, claimed: number, nowMs: number, maxLevel: number): { level: number; clamped: boolean; first: boolean } {
  const capped = Math.min(Math.max(1, Math.floor(claimed)), maxLevel);
  if (prevLevel === null || prevAtMs === null) return { level: capped, clamped: capped < claimed, first: true };
  if (capped <= prevLevel) return { level: prevLevel, clamped: false, first: false };
  const elapsed = Math.max(0, (nowMs - prevAtMs) / 1000);
  const ceiling = prevLevel + Math.min(MAX_STEP, FREE_LEVELS + Math.floor(elapsed / SECONDS_PER_LEVEL));
  const level = Math.min(capped, ceiling);
  return { level, clamped: level < claimed, first: false };
}

/** Whether a claim counts against the player: far over what could be played, or a high first claim. */
export function claimSuspect(claimed: number, decision: { level: number; first: boolean }): boolean {
  if (decision.first) return decision.level >= FIRST_CLAIM_FLAG;
  return claimed - decision.level > SUSPECT_MARGIN;
}

type Top = { rows: Array<BoardRowOut & { playerId: string }>; at: string };
const topCache = new TtlCache<Top>(config.leaderboard.cacheMs, 4);
const rankCache = new TtlCache<{ rank: number; level: number } | null>(config.leaderboard.cacheMs, 50_000);
const totalCache = new TtlCache<number>(60_000, 2);

export interface SubmitResult {
  level: number;
  accepted: boolean;
  clamped: boolean;
  first: boolean;
  previous: number | null;
  /** The row is (now) left out of the others' boards. */
  hidden: boolean;
}

export const leaderboardService = {
  async submit(playerId: string, claimed: number, profile: { name: string; avatar: string; frame: string }, stats?: Stats): Promise<SubmitResult> {
    const ref = col.leaderboard().doc(playerId);
    const result = await col.leaderboard().firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const prev = snap.exists ? (snap.data() as BoardEntry) : null;
      const now = Date.now();
      const decision = allowedLevel(prev?.level ?? null, prev?.levelReachedAt?.toMillis() ?? null, claimed, now, config.leaderboard.maxLevel);
      const rises = !prev || decision.level > prev.level;
      const prevStats = (prev as { stats?: Stats } | null)?.stats;
      const statsChanged = !!stats && (!prevStats || prevStats.firstTry !== stats.firstTry || prevStats.bestStreak !== stats.bestStreak || prevStats.eventWins !== stats.eventWins);
      const profileChanged = !prev || prev.name !== profile.name || prev.avatar !== profile.avatar || prev.frame !== profile.frame || statsChanged;
      // suspectCount (any cut claim, kept for support) is not what hides: strikes are (counted
      // from this rule on, so rows marked under the older, looser one are not hidden by it).
      const suspicious = decision.clamped || (decision.first && decision.level >= FIRST_CLAIM_FLAG);
      const strike = claimSuspect(claimed, decision);
      const count = (prev?.strikes ?? 0) + (strike ? 1 : 0);
      // A brand-new row starting high: every real player's row rose with them level by level
      // (and a new device opening the account keeps its row), so it is an edited game; hidden at once.
      const freshHigh = decision.first && decision.level >= FIRST_CLAIM_FLAG;
      const hidden = !!prev?.hidden || count >= HIDE_AFTER || freshHigh;
      const hides = hidden && !prev?.hidden;
      if (rises || profileChanged || strike) {
        const update: Record<string, unknown> = {
          playerId,
          name: profile.name,
          avatar: profile.avatar,
          frame: profile.frame,
          level: decision.level,
          updatedAt: Timestamp.fromMillis(now),
        };
        if (rises) update.levelReachedAt = Timestamp.fromMillis(now);
        if (stats) update.stats = stats;
        if (suspicious) {
          update.suspectCount = FieldValue.increment(1);
          update.lastSuspectAt = Timestamp.fromMillis(now);
          update.lastSuspectClaim = claimed;
        }
        if (strike) update.strikes = FieldValue.increment(1);
        if (hides) update.hidden = true;
        tx.set(ref, update, { merge: true });
      }
      return { level: decision.level, accepted: rises, clamped: decision.clamped, first: decision.first, previous: prev?.level ?? null, hidden, hides };
    });
    if (result.hides) {
      topCache.clear();
      logger.warn({ playerId, claimed }, 'leaderboard: row hidden after suspect claims');
    }
    if (result.accepted) {
      rankCache.delete(playerId);
      // The player's own record keeps the level too (for support), off the request's path.
      void col.players().doc(playerId).update({ level: result.level, levelUpdatedAt: FieldValue.serverTimestamp() }).catch(() => undefined);
      // An invited friend reaching the level that counts for their inviter.
      void referralService.onLevel(playerId, result.level).catch((err) => logger.warn({ err, playerId }, 'referral: level not counted'));
    }
    return { level: result.level, accepted: result.accepted, clamped: result.clamped, first: result.first, previous: result.previous, hidden: result.hidden };
  },

  /**
   * One thing against the player from elsewhere (a save richer than possible): counted as a
   * suspect claim; `hide` hides the row at once. Nothing when the player has no row yet.
   */
  async flag(playerId: string, reason: string, hide: boolean): Promise<void> {
    const ref = col.leaderboard().doc(playerId);
    const hid = await col.leaderboard().firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const prev = snap.data() as BoardEntry;
      const count = (prev.strikes ?? 0) + 1;
      const hidden = !!prev.hidden || hide || count >= HIDE_AFTER;
      tx.update(ref, { strikes: count, suspectCount: FieldValue.increment(1), lastSuspectAt: Timestamp.now(), lastSuspectReason: reason, ...(hidden ? { hidden: true } : {}) });
      return hidden && !prev.hidden;
    });
    if (hid) {
      topCache.clear();
      logger.warn({ playerId, reason }, 'leaderboard: row hidden');
    }
  },

  /** Whether the player's row is hidden from the others' boards. */
  async isHidden(playerId: string): Promise<boolean> {
    const snap = await col.leaderboard().doc(playerId).get();
    return snap.exists && !!snap.get('hidden');
  },

  /**
   * The board as `viewer` sees it: the hidden rows left out but the viewer's own (a hidden
   * player sees their row and place as before), the places counted again.
   */
  async topFor(viewer: string): Promise<Top> {
    const top = await this.top();
    const rows = top.rows.filter((r) => !r.hidden || r.playerId === viewer).slice(0, config.leaderboard.topLimit);
    return { rows: rows.map((r, i) => ({ ...r, rank: i + 1 })), at: top.at };
  },

  async top(): Promise<Top> {
    return topCache.getOrLoad('world', async () => {
      const snap = await col
        .leaderboard()
        .orderBy('level', 'desc')
        .orderBy('levelReachedAt', 'asc')
        // A few over the limit: the hidden ones are left out per viewer (topFor).
        .limit(config.leaderboard.topLimit + 50)
        .select('name', 'avatar', 'frame', 'level', 'team', 'hidden', 'stats')
        .get();
      const rows = snap.docs.map((d, i) => {
        const x = d.data() as Pick<BoardEntry, 'name' | 'avatar' | 'frame' | 'level' | 'hidden'> & { team?: string; stats?: Stats };
        return { rank: i + 1, playerId: d.id, name: x.name, avatar: x.avatar, frame: x.frame, level: x.level, ...(x.team ? { team: x.team } : {}), ...(x.hidden ? { hidden: true } : {}), ...(x.stats ? { stats: x.stats } : {}) };
      });
      return { rows, at: new Date().toISOString() };
    });
  },

  async rankOf(playerId: string): Promise<{ rank: number; level: number } | null> {
    return rankCache.getOrLoad(playerId, async () => {
      const snap = await col.leaderboard().doc(playerId).get();
      if (!snap.exists) return null;
      const me = snap.data() as BoardEntry;
      const [above, tiedBefore] = await Promise.all([
        col.leaderboard().where('level', '>', me.level).count().get(),
        col.leaderboard().where('level', '==', me.level).where('levelReachedAt', '<', me.levelReachedAt).count().get(),
      ]);
      return { rank: above.data().count + tiedBefore.data().count + 1, level: me.level };
    });
  },

  async total(): Promise<number> {
    return totalCache.getOrLoad('all', async () => (await col.leaderboard().count().get()).data().count);
  },

  async remove(playerId: string): Promise<void> {
    await col.leaderboard().doc(playerId).delete();
    rankCache.delete(playerId);
    topCache.clear();
  },

  forgetCaches(): void {
    topCache.clear();
    rankCache.clear();
  },
};
