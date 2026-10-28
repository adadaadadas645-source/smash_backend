import { z } from 'zod';
import { col, FieldValue } from '../firebase';
import { AppError } from '../middleware/errorHandler';
import { currentContext } from '../utils/context';
import { logSecurityEvent, logger } from '../utils/logger';
import { dbLog } from './logStore';

/**
 * kingdom_saves/{playerId}: the game's save in the cloud, the same JSON it keeps on the device
 * under each of its keys (level, coins and boosters, lives, the road, ...). The device plays on
 * its own save and sends it a few seconds after each change; a new device that opens the
 * account (POST /auth/recover) gets it back. `rev` only goes up, so an older copy never
 * overwrites a newer one.
 *
 * The coins and the boosters are copied out of the progress key to plain fields, for support
 * and for the check against what was bought (a save far richer than any player could be is
 * logged as suspicious, not refused: the save stays the player's).
 */

/** The game's save keys that travel with the account (Backend.cs CloudSave.Keys). */
export const SAVE_KEYS = [
  'royal_smash_progress_v1',
  'royal_smash_lives_v1',
  'royal_smash_profile_v1',
  'royal_smash_welcome_offer_v1',
  'royal_smash_atelier_v1',
  'royal_smash_treasure_map_v1',
  'royal_smash_road_v1',
  'royal_smash_arsenal_v1',
  'royal_smash_kingdom_v1',
  'royal_smash_noads_v1',
  'royal_smash_granted_v1',
  'royal_smash_daily_v1',
  'royal_smash_defense_v1',
  'royal_smash_wall_v1',
  'royal_smash_party_free_v1',
  'royal_smash_party_ads_v1',
] as const;

const MAX_VALUE = 16 * 1024;
const MAX_TOTAL = 48 * 1024;

export const saveSchema = z.object({
  rev: z.number().int().min(1).max(1e12),
  keys: z.record(z.string(), z.string().max(MAX_VALUE)),
});

export interface SaveDoc {
  playerId: string;
  rev: number;
  keys: Record<string, string>;
  level: number;
  coins: number;
  boosters: Record<string, number>;
  updatedAt: FirebaseFirestore.Timestamp;
}

/** Level, coins and booster counts out of the progress key; zeros when it cannot be read. */
export function summarize(keys: Record<string, string>): { level: number; coins: number; boosters: Record<string, number> } {
  const out = { level: 0, coins: 0, boosters: {} as Record<string, number> };
  try {
    const p = JSON.parse(keys.royal_smash_progress_v1 ?? '{}');
    out.level = Number.isFinite(p.level) ? Math.floor(p.level) : 0;
    out.coins = Number.isFinite(p.coins) ? Math.floor(p.coins) : 0;
    for (const [id, b] of Object.entries((p.boosters ?? {}) as Record<string, { count?: number }>)) {
      if (Number.isFinite(b?.count)) out.boosters[id] = Math.floor(b.count as number);
    }
  } catch {
    // An unreadable progress: kept as sent, nothing to copy out.
  }
  return out;
}

/** More coins than the purchases and the levels played could have brought (generous on purpose). */
export function coinsLookWrong(coins: number, level: number, purchasedCoins: number): boolean {
  return coins > purchasedCoins + Math.max(1, level) * 600 + 20_000;
}

export const saveService = {
  async get(playerId: string): Promise<SaveDoc | null> {
    const snap = await col.saves().doc(playerId).get();
    return snap.exists ? (snap.data() as SaveDoc) : null;
  },

  /** Stores the device's save; 409 `stale_save` when a newer one is already here, 401 `session_replaced` from an old device. */
  async put(playerId: string, tokenGen: number, input: z.infer<typeof saveSchema>): Promise<{ rev: number }> {
    const keys: Record<string, string> = {};
    let total = 0;
    for (const k of SAVE_KEYS) {
      const v = input.keys[k];
      if (typeof v !== 'string') continue;
      keys[k] = v;
      total += v.length;
    }
    if (total > MAX_TOTAL) throw new AppError(413, 'save_too_large');
    const sum = summarize(keys);
    const ref = col.saves().doc(playerId);
    const playerRef = col.players().doc(playerId);
    let purchasedCoins = 0;
    await col.saves().firestore.runTransaction(async (tx) => {
      const [player, prev] = await Promise.all([tx.get(playerRef), tx.get(ref)]);
      if (!player.exists) throw new AppError(401, 'player_not_found');
      // The account was opened on another device since this token was given.
      if ((player.get('gen') ?? 0) !== tokenGen) throw new AppError(401, 'session_replaced');
      const prevRev = prev.exists ? ((prev.get('rev') as number) ?? 0) : 0;
      if (input.rev <= prevRev) throw new AppError(409, 'stale_save', 'A newer save is already stored', { rev: prevRev });
      purchasedCoins = (player.get('purchasedCoins') as number | undefined) ?? 0;
      tx.set(ref, {
        playerId,
        rev: input.rev,
        keys,
        level: sum.level,
        coins: sum.coins,
        boosters: sum.boosters,
        updatedAt: FieldValue.serverTimestamp(),
        appVersion: currentContext()?.appVersion ?? null,
      });
    });
    if (coinsLookWrong(sum.coins, sum.level, purchasedCoins)) {
      const data = { coins: sum.coins, level: sum.level, purchasedCoins, rev: input.rev };
      logSecurityEvent('save_coins_suspicious', { playerId, ...data });
      dbLog.security('save_coins_suspicious', data, playerId);
    }
    logger.debug({ playerId, rev: input.rev, level: sum.level, coins: sum.coins }, 'save stored');
    return { rev: input.rev };
  },
};
