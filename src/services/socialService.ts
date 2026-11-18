import { col, FieldValue, Timestamp } from '../firebase';
import { AppError } from '../middleware/errorHandler';
import { TtlCache } from '../utils/ttlCache';
import { leaderboardService } from './leaderboardService';
import { normalizeCode, referralService } from './referralService';

/**
 * The social side of the leaderboard: the weekly race, friends, and the board of one country.
 *
 * Weekly race: kingdom_weekly/{week}_{playerId} { week, playerId, points, name, avatar, frame }:
 * a point for each level won this week (Monday 00:00 UTC to the next). Read as one query per
 * week (no composite index: sorted here), shared for WEEKLY_CACHE_MS.
 *
 * Friends: the invite code is the friend id ("Your ID"). kingdom_friends/{owner}__{other}
 * { owner, other, status: friend | incoming | outgoing, at }: both sides have their row, so a
 * player's list is one query on `owner`. Names and levels come from the leaderboard.
 *
 * Country board: the leaderboard row's `country` (from the player's locale, written as levels
 * come), one query per country, sorted here.
 */
export const MAX_FRIENDS = 100;
const WEEKLY_CACHE_MS = 30_000;
const COUNTRY_CACHE_MS = 60_000;
const READ_LIMIT = 2000;

type Row = { rank: number; playerId: string; name: string; avatar: string; frame: string; level: number; points?: number; team?: string; hidden?: boolean };

const weeklyCache = new TtlCache<Row[]>(WEEKLY_CACHE_MS, 4);
const countryCache = new TtlCache<Row[]>(COUNTRY_CACHE_MS, 50);

/** The week's id, "2026-11-16" (its Monday, UTC), and when it ends. */
export function weekOf(ms: number): { id: string; endsAt: number } {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday 0
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
  return { id: new Date(monday).toISOString().slice(0, 10), endsAt: monday + 7 * 86400_000 };
}

/** "tr-TR", "tr_TR", "en-US" → "TR", "US"; a language alone → its main country ("tr" → "TR"). */
export function countryOf(locale: string | null | undefined): string | null {
  if (!locale) return null;
  const parts = String(locale).split(/[-_]/);
  const region = parts.find((p, i) => i > 0 && /^[A-Za-z]{2}$/.test(p));
  if (region) return region.toUpperCase();
  const lang = (parts[0] || '').toLowerCase();
  const MAIN: Record<string, string> = { tr: 'TR', de: 'DE', fr: 'FR', it: 'IT', es: 'ES', pt: 'BR', ru: 'RU', ja: 'JP', ko: 'KR', en: 'US', ar: 'SA', nl: 'NL', pl: 'PL', az: 'AZ' };
  return MAIN[lang] ?? null;
}

function ranked<T extends { level: number; points?: number }>(rows: T[], by: 'level' | 'points'): (T & { rank: number })[] {
  return rows
    .sort((a, b) => (by === 'points' ? (b.points ?? 0) - (a.points ?? 0) || b.level - a.level : b.level - a.level))
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

async function boardRows(ids: string[]) {
  type BoardRow = { name: string; avatar: string; frame: string; level: number; team?: string; hidden?: boolean };
  if (ids.length === 0) return new Map<string, BoardRow>();
  const snaps = await col.leaderboard().firestore.getAll(...ids.map((id) => col.leaderboard().doc(id)));
  const out = new Map<string, BoardRow>();
  for (const s of snaps)
    if (s.exists)
      out.set(s.id, {
        name: s.get('name'),
        avatar: s.get('avatar'),
        frame: s.get('frame'),
        level: s.get('level') ?? 1,
        ...(s.get('team') ? { team: s.get('team') as string } : {}),
        ...(s.get('hidden') ? { hidden: true } : {}),
      });
  return out;
}

/**
 * A board as `viewer` sees it: the hidden rows (leaderboardService: suspect claims) left out but
 * the viewer's own, the places counted again, without the hidden mark.
 */
export function visibleTo<T extends { rank: number; playerId: string; hidden?: boolean }>(rows: T[], viewer: string): T[] {
  return rows.filter((r) => !r.hidden || r.playerId === viewer).map(({ hidden: _hidden, ...r }, i) => ({ ...r, rank: i + 1 }) as T);
}

export const socialService = {
  /** After a level is taken on the board: the week's points and the row's country. */
  async onLevel(playerId: string, gained: number, profile: { name: string; avatar: string; frame: string; level: number; locale?: string | null }) {
    const week = weekOf(Date.now());
    const writes: Promise<unknown>[] = [];
    if (gained > 0) {
      writes.push(
        col.weekly().doc(`${week.id}_${playerId}`).set(
          { week: week.id, playerId, points: FieldValue.increment(Math.min(gained, 50)), name: profile.name, avatar: profile.avatar, frame: profile.frame, level: profile.level, updatedAt: Timestamp.now() },
          { merge: true },
        ),
      );
    }
    const country = countryOf(profile.locale);
    if (country) writes.push(col.leaderboard().doc(playerId).set({ country }, { merge: true }));
    await Promise.all(writes);
  },

  async weekly(playerId: string) {
    const week = weekOf(Date.now());
    const all = await weeklyCache.getOrLoad(week.id, async () => {
      const snap = await col.weekly().where('week', '==', week.id).limit(READ_LIMIT).get();
      const rows = ranked(
        snap.docs.map((d) => ({ rank: 0, playerId: d.get('playerId'), name: d.get('name'), avatar: d.get('avatar'), frame: d.get('frame'), level: d.get('level') ?? 1, points: d.get('points') ?? 0 }) as Row),
        'points',
      );
      // The teams of the first ones (the list shows them under the names), and the hidden ones
      // among them (left out for the others below).
      const head = rows.slice(0, 200);
      const board = await boardRows(head.map((r) => r.playerId));
      for (const r of head) {
        const b = board.get(r.playerId);
        if (b?.team) r.team = b.team;
        if (b?.hidden) r.hidden = true;
      }
      return rows;
    });
    const rows = visibleTo(all, playerId);
    const me = rows.find((r) => r.playerId === playerId);
    return { week: week.id, endsInMs: week.endsAt - Date.now(), top: rows.slice(0, 100), me: me ? { rank: me.rank, points: me.points ?? 0 } : null, total: rows.length };
  },

  async country(playerId: string, code: string) {
    const country = String(code || '').toUpperCase().slice(0, 2);
    if (!/^[A-Z]{2}$/.test(country)) throw new AppError(400, 'bad_country');
    const all = await countryCache.getOrLoad(country, async () => {
      const snap = await col.leaderboard().where('country', '==', country).limit(READ_LIMIT).get();
      return ranked(
        snap.docs.map((d) => ({ rank: 0, playerId: d.id, name: d.get('name'), avatar: d.get('avatar'), frame: d.get('frame'), level: d.get('level') ?? 1, ...(d.get('team') ? { team: d.get('team') as string } : {}), ...(d.get('hidden') ? { hidden: true } : {}) }) as Row),
        'level',
      );
    });
    const rows = visibleTo(all, playerId);
    const me = rows.find((r) => r.playerId === playerId);
    return { country, top: rows.slice(0, 100), me: me ? { rank: me.rank, level: me.level } : null, total: rows.length };
  },

  // ── Friends ─────────────────────────────────────────────────────────────────

  async friends(playerId: string) {
    const snap = await col.friends().where('owner', '==', playerId).limit(MAX_FRIENDS * 2).get();
    const links = snap.docs.map((d) => ({ other: d.get('other') as string, status: d.get('status') as 'friend' | 'incoming' | 'outgoing' }));
    const board = await boardRows([...links.map((l) => l.other), playerId]);
    const row = (id: string) => {
      const { hidden: _hidden, ...b } = board.get(id) ?? { name: 'Player', avatar: 'leo', frame: 'gold', level: 1 };
      return { playerId: id, ...b };
    };
    const friends = ranked([...links.filter((l) => l.status === 'friend').map((l) => row(l.other)), { ...row(playerId), me: true }], 'level');
    return {
      code: await referralService.codeOf(playerId),
      friends,
      incoming: links.filter((l) => l.status === 'incoming').map((l) => row(l.other)),
      outgoing: links.filter((l) => l.status === 'outgoing').map((l) => row(l.other)),
    };
  },

  /** A friend request by their ID (invite code); one already asking me is accepted instead. */
  async request(playerId: string, rawCode: string): Promise<{ status: 'outgoing' | 'friend' }> {
    const code = normalizeCode(rawCode);
    const invite = code ? await col.invites().doc(code).get() : null;
    const other = invite?.exists ? (invite.get('playerId') as string) : null;
    if (!other) throw new AppError(404, 'player_not_found');
    if (other === playerId) throw new AppError(400, 'own_id');
    const mineRef = col.friends().doc(`${playerId}__${other}`);
    const theirsRef = col.friends().doc(`${other}__${playerId}`);
    const count = (await col.friends().where('owner', '==', playerId).count().get()).data().count;
    if (count >= MAX_FRIENDS * 2) throw new AppError(409, 'too_many_friends');
    return col.friends().firestore.runTransaction(async (tx) => {
      const [mine, theirs] = await Promise.all([tx.get(mineRef), tx.get(theirsRef)]);
      const at = Timestamp.now();
      if (mine.exists && mine.get('status') === 'friend') return { status: 'friend' as const };
      if (mine.exists && mine.get('status') === 'incoming') {
        tx.set(mineRef, { owner: playerId, other, status: 'friend', at });
        tx.set(theirsRef, { owner: other, other: playerId, status: 'friend', at });
        return { status: 'friend' as const };
      }
      if (!theirs.exists) tx.set(theirsRef, { owner: other, other: playerId, status: 'incoming', at });
      tx.set(mineRef, { owner: playerId, other, status: 'outgoing', at });
      return { status: 'outgoing' as const };
    });
  },

  async answer(playerId: string, other: string, accept: boolean) {
    const mineRef = col.friends().doc(`${playerId}__${other}`);
    const theirsRef = col.friends().doc(`${other}__${playerId}`);
    await col.friends().firestore.runTransaction(async (tx) => {
      const mine = await tx.get(mineRef);
      if (!mine.exists || mine.get('status') !== 'incoming') throw new AppError(404, 'no_request');
      if (accept) {
        const at = Timestamp.now();
        tx.set(mineRef, { owner: playerId, other, status: 'friend', at });
        tx.set(theirsRef, { owner: other, other: playerId, status: 'friend', at });
      } else {
        tx.delete(mineRef);
        tx.delete(theirsRef);
      }
    });
  },

  async remove(playerId: string, other: string) {
    await Promise.all([col.friends().doc(`${playerId}__${other}`).delete(), col.friends().doc(`${other}__${playerId}`).delete()]);
  },

  /** Players near the top of the board who are not friends yet (the "Suggested" list). */
  async suggested(playerId: string) {
    const [top, mine] = await Promise.all([leaderboardService.topFor(playerId), col.friends().where('owner', '==', playerId).limit(MAX_FRIENDS * 2).get()]);
    const known = new Set([playerId, ...mine.docs.map((d) => d.get('other') as string)]);
    const pool = top.rows.filter((r) => !known.has(r.playerId) && !r.hidden);
    // A few strong players and a few at random, so the list is not the same for everyone.
    const pick = [...pool.slice(0, 3), ...pool.slice(3).sort(() => Math.random() - 0.5).slice(0, 7)];
    const codes = await Promise.all(pick.map((r) => col.players().doc(r.playerId).get().then((s) => (s.get('inviteCode') as string | undefined) ?? null)));
    return pick
      .map((r, i) => ({ playerId: r.playerId, name: r.name, avatar: r.avatar, frame: r.frame, level: r.level, code: codes[i] }))
      .filter((r) => r.code);
  },
};
