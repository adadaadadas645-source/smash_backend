import { col, FieldValue, Timestamp } from '../firebase';
import { currentContext } from '../utils/context';
import { TtlCache } from '../utils/ttlCache';

/**
 * kingdom_players/{playerId}: who the player is (the hash of the device secret), what the game
 * last said about the device, the profile shown on the leaderboard, and what was bought for
 * good (no ads forever). The token check reads it through a one-minute cache, so an API call
 * does not cost a Firestore read each time.
 */
export interface PlayerDoc {
  playerId: string;
  deviceSecretHash: string;
  name: string;
  avatar: string;
  frame: string;
  level: number;
  banned: boolean;
  banReason?: string | null;
  noAdsForever: boolean;
  purchaseCount: number;
  createdAt: FirebaseFirestore.Timestamp;
  lastSeenAt: FirebaseFirestore.Timestamp;
  lastIp?: string | null;
  installId?: string | null;
  appVersion?: string | null;
  platform?: string | null;
  deviceModel?: string | null;
  locale?: string | null;
}

export interface PlayerStatus {
  exists: boolean;
  banned: boolean;
}

const statusCache = new TtlCache<PlayerStatus>(60_000, 50_000);
/** lastSeenAt is written at most once per this long per player. */
const SEEN_EVERY_MS = 10 * 60_000;
const seenCache = new TtlCache<true>(SEEN_EVERY_MS, 50_000);

export const playerService = {
  async create(playerId: string, deviceSecretHash: string, profile: { name: string; avatar: string; frame: string; locale?: string }): Promise<PlayerDoc> {
    const ctx = currentContext();
    const now = Timestamp.now();
    const doc: PlayerDoc = {
      playerId,
      deviceSecretHash,
      name: profile.name,
      avatar: profile.avatar,
      frame: profile.frame,
      level: 1,
      banned: false,
      banReason: null,
      noAdsForever: false,
      purchaseCount: 0,
      createdAt: now,
      lastSeenAt: now,
      lastIp: ctx?.ip ?? null,
      installId: ctx?.installId ?? null,
      appVersion: ctx?.appVersion ?? null,
      platform: ctx?.platform ?? null,
      deviceModel: ctx?.deviceModel ?? null,
      locale: profile.locale ?? null,
    };
    await col.players().doc(playerId).create(doc);
    statusCache.set(playerId, { exists: true, banned: false });
    seenCache.set(playerId, true);
    return doc;
  },

  async get(playerId: string): Promise<PlayerDoc | null> {
    const snap = await col.players().doc(playerId).get();
    if (!snap.exists) return null;
    const doc = snap.data() as PlayerDoc;
    statusCache.set(playerId, { exists: true, banned: !!doc.banned });
    return doc;
  },

  /** For the token check: cached for a minute. */
  async status(playerId: string): Promise<PlayerStatus> {
    return statusCache.getOrLoad(playerId, async () => {
      const snap = await col.players().doc(playerId).get();
      if (!snap.exists) return { exists: false, banned: false };
      return { exists: true, banned: !!(snap.get('banned') as boolean | undefined) };
    });
  },

  forgetStatus(playerId: string): void {
    statusCache.delete(playerId);
  },

  /** What the game says about the device, written now and then (not on every call). */
  touch(playerId: string): void {
    if (seenCache.get(playerId)) return;
    seenCache.set(playerId, true);
    const ctx = currentContext();
    void col
      .players()
      .doc(playerId)
      .update({
        lastSeenAt: FieldValue.serverTimestamp(),
        lastIp: ctx?.ip ?? null,
        appVersion: ctx?.appVersion ?? null,
        platform: ctx?.platform ?? null,
        deviceModel: ctx?.deviceModel ?? null,
        installId: ctx?.installId ?? null,
      })
      .catch(() => seenCache.delete(playerId));
  },

  async updateProfile(playerId: string, profile: { name?: string; avatar?: string; frame?: string; locale?: string }): Promise<void> {
    const update: Record<string, unknown> = {};
    if (profile.name !== undefined) update.name = profile.name;
    if (profile.avatar !== undefined) update.avatar = profile.avatar;
    if (profile.frame !== undefined) update.frame = profile.frame;
    if (profile.locale !== undefined) update.locale = profile.locale;
    if (Object.keys(update).length === 0) return;
    update.profileUpdatedAt = FieldValue.serverTimestamp();
    await col.players().doc(playerId).update(update);
  },

  async setBanned(playerId: string, banned: boolean, reason: string | null): Promise<void> {
    await col.players().doc(playerId).update({ banned, banReason: reason, bannedAt: banned ? FieldValue.serverTimestamp() : null });
    statusCache.set(playerId, { exists: true, banned });
  },
};

/** What the game may know about its own player. */
export function publicPlayer(doc: PlayerDoc) {
  return {
    playerId: doc.playerId,
    name: doc.name,
    avatar: doc.avatar,
    frame: doc.frame,
    level: doc.level,
    noAdsForever: !!doc.noAdsForever,
    purchaseCount: doc.purchaseCount ?? 0,
    createdAt: doc.createdAt?.toDate?.().toISOString?.() ?? null,
  };
}
