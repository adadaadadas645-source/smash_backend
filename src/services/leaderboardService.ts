import { config } from '../config';
import { col, FieldValue, Timestamp } from '../firebase';
import { TtlCache } from '../utils/ttlCache';

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
 * few levels plus one per 15 seconds since. A claim beyond that is cut to it and marked, never
 * taken as is. The first claim of a player is taken (players already had their levels before
 * the board existed) but marked when it is high.
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
}

export interface BoardRowOut {
  rank: number;
  name: string;
  avatar: string;
  frame: string;
  level: number;
  me?: boolean;
}

export const SECONDS_PER_LEVEL = 15;
export const FREE_LEVELS = 3;
export const FIRST_CLAIM_FLAG = 150;

/** The highest level the server takes now, given the last accepted one and when it came. */
export function allowedLevel(prevLevel: number | null, prevAtMs: number | null, claimed: number, nowMs: number, maxLevel: number): { level: number; clamped: boolean; first: boolean } {
  const capped = Math.min(Math.max(1, Math.floor(claimed)), maxLevel);
  if (prevLevel === null || prevAtMs === null) return { level: capped, clamped: capped < claimed, first: true };
  if (capped <= prevLevel) return { level: prevLevel, clamped: false, first: false };
  const elapsed = Math.max(0, (nowMs - prevAtMs) / 1000);
  const ceiling = prevLevel + FREE_LEVELS + Math.floor(elapsed / SECONDS_PER_LEVEL);
  const level = Math.min(capped, ceiling);
  return { level, clamped: level < claimed, first: false };
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
}

export const leaderboardService = {
  async submit(playerId: string, claimed: number, profile: { name: string; avatar: string; frame: string }): Promise<SubmitResult> {
    const ref = col.leaderboard().doc(playerId);
    const result = await col.leaderboard().firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const prev = snap.exists ? (snap.data() as BoardEntry) : null;
      const now = Date.now();
      const decision = allowedLevel(prev?.level ?? null, prev?.levelReachedAt?.toMillis() ?? null, claimed, now, config.leaderboard.maxLevel);
      const rises = !prev || decision.level > prev.level;
      const profileChanged = !prev || prev.name !== profile.name || prev.avatar !== profile.avatar || prev.frame !== profile.frame;
      const suspicious = decision.clamped || (decision.first && decision.level >= FIRST_CLAIM_FLAG);
      if (rises || profileChanged) {
        const update: Record<string, unknown> = {
          playerId,
          name: profile.name,
          avatar: profile.avatar,
          frame: profile.frame,
          level: decision.level,
          updatedAt: Timestamp.fromMillis(now),
        };
        if (rises) update.levelReachedAt = Timestamp.fromMillis(now);
        if (suspicious) {
          update.suspectCount = FieldValue.increment(1);
          update.lastSuspectAt = Timestamp.fromMillis(now);
          update.lastSuspectClaim = claimed;
        }
        tx.set(ref, update, { merge: true });
      }
      return { level: decision.level, accepted: rises, clamped: decision.clamped, first: decision.first, previous: prev?.level ?? null };
    });
    if (result.accepted) {
      rankCache.delete(playerId);
      // The player's own record keeps the level too (for support), off the request's path.
      void col.players().doc(playerId).update({ level: result.level, levelUpdatedAt: FieldValue.serverTimestamp() }).catch(() => undefined);
    }
    return result;
  },

  async top(): Promise<Top> {
    return topCache.getOrLoad('world', async () => {
      const snap = await col
        .leaderboard()
        .orderBy('level', 'desc')
        .orderBy('levelReachedAt', 'asc')
        .limit(config.leaderboard.topLimit)
        .select('name', 'avatar', 'frame', 'level')
        .get();
      const rows = snap.docs.map((d, i) => {
        const x = d.data() as Pick<BoardEntry, 'name' | 'avatar' | 'frame' | 'level'>;
        return { rank: i + 1, playerId: d.id, name: x.name, avatar: x.avatar, frame: x.frame, level: x.level };
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
