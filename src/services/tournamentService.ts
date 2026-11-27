import { config } from '../config';
import { col, db, FieldValue, Timestamp } from '../firebase';
import { AppError } from '../middleware/errorHandler';
import { runIndexedQuery } from '../utils/indexedQuery';
import { TtlCache } from '../utils/ttlCache';
import { leaderboardService } from './leaderboardService';
import { playerService } from './playerService';
import {
  allowedAdd,
  botOf,
  botPoints,
  GRACE_MS,
  GROUP_SIZE,
  hash,
  JOIN_CLOSES_MS,
  nextWindow,
  prizeFor,
  PRIZES,
  rank,
  scheduleFromEnv,
  shadowGroupOf,
  Standing,
  Window,
  windowAt,
  windowOfId,
} from './tournamentRules';

/**
 * The Arrow Tournament (tournamentRules: windows, groups of five, bots, prizes).
 *
 * kingdom_tournament_windows/{window}            { joined }  (places handed out: group = place / 5)
 * kingdom_tournament_entries/{window}_{playerId} { window, playerId, group, points, lastAt, joinedAt, name, avatar, frame }
 * kingdom_tournament_prizes/{window}_{playerId}  { window, playerId, place, prize, at }  (taken once)
 *
 * Its own collections: nothing else in the game's data is read or written but the player's
 * name, face and frame (the leaderboard row, else the player).
 */
const prefix = config.collections.players.replace(/players$/, '');
const windows = () => db.collection(`${prefix}tournament_windows`);
const entries = () => db.collection(`${prefix}tournament_entries`);
const prizes = () => db.collection(`${prefix}tournament_prizes`);

const schedule = scheduleFromEnv();
const groupCache = new TtlCache<Standing[]>(4_000, 2000);

type Profile = { id: string; name: string; avatar: string; frame: string };
/** Each window's pool of real players (the world board's, the hidden left out), taken once so the names stay put through it. */
const ghostPools = new TtlCache<Profile[]>(3 * 60 * 60_000, 50);

async function ghostPool(windowId: string): Promise<Profile[]> {
  return ghostPools.getOrLoad(windowId, async () => {
    try {
      const top = await leaderboardService.top();
      return top.rows
        .filter((r) => !r.hidden && r.name)
        .map((r) => ({ id: r.playerId, name: r.name, avatar: r.avatar, frame: r.frame }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    } catch {
      return [];
    }
  });
}

type Entry = { window: string; playerId: string; group: number; points: number; lastAt: number; joinedAt: number; name: string; avatar: string; frame: string };

function entryOf(data: FirebaseFirestore.DocumentData | undefined): Entry | null {
  if (!data) return null;
  return {
    window: data.window,
    playerId: data.playerId,
    group: data.group ?? 0,
    points: data.points ?? 0,
    lastAt: data.lastAt ?? 0,
    joinedAt: data.joinedAt ?? 0,
    name: data.name ?? 'Player',
    avatar: data.avatar ?? 'leo',
    frame: data.frame ?? 'gold',
  };
}

async function profileOf(playerId: string, given: { name?: string; avatar?: string; frame?: string }) {
  if (given.name && given.avatar && given.frame) return given as { name: string; avatar: string; frame: string };
  const row = await col.leaderboard().doc(playerId).get();
  const p = row.exists ? null : await playerService.get(playerId);
  const pick = (k: 'name' | 'avatar' | 'frame', fallback: string): string => given[k] ?? (row.exists ? (row.get(k) as string | undefined) : undefined) ?? p?.[k] ?? fallback;
  return { name: pick('name', 'Player'), avatar: pick('avatar', 'leo'), frame: pick('frame', 'gold') };
}

/** A group's real players (cached a few seconds: everyone in it asks every few seconds). */
async function realRows(w: Window, group: number): Promise<Standing[]> {
  return groupCache.getOrLoad(`${w.id}|${group}`, async () => {
    const snap = await entries().where('window', '==', w.id).where('group', '==', group).limit(GROUP_SIZE + 2).get();
    return snap.docs.map((d) => {
      const e = entryOf(d.data())!;
      return { id: e.playerId, name: e.name, avatar: e.avatar, frame: e.frame, points: e.points, joinedAt: e.joinedAt, bot: false };
    });
  });
}

/** The group as it stands `at`: its real players and bots in the places still empty, ranked. */
async function standings(w: Window, group: number, at: number) {
  const real = await realRows(w, group);
  const rows = [...real];
  // The places no one has taken yet: real players of the game (the world board's), the same ones
  // for everyone in the group, playing at a bot's pace; a made-up one only while there is no board.
  const pool = await ghostPool(w.id);
  const used = new Set(real.map((r) => r.id));
  const names = new Set(real.map((r) => r.name));
  for (let place = 0; rows.length < GROUP_SIZE && place < 200; place++) {
    const b = botOf(w.id, group, place);
    let who: Profile = { id: b.botId, name: b.name, avatar: b.avatar, frame: b.frame };
    if (pool.length > 0) {
      let k = hash(`${w.id}|${group}|${place}|ghost`) % pool.length;
      for (let t = 0; t < pool.length && used.has(pool[k].id); t++) k = (k + 1) % pool.length;
      if (!used.has(pool[k].id)) who = { ...pool[k], id: `ghost_${pool[k].id}` };
      used.add(pool[k].id);
    }
    // No two of the same name in a group.
    if (names.has(who.name)) continue;
    names.add(who.name);
    rows.push({ id: who.id, name: who.name, avatar: who.avatar, frame: who.frame, points: botPoints(b, w, at), joinedAt: w.startsAt + b.startDelay * 1000, bot: true });
  }
  return rank(rows);
}

function view(rows: Awaited<ReturnType<typeof standings>>, me: string) {
  return rows.map((r) => ({ rank: r.rank, name: r.name, avatar: r.avatar, frame: r.frame, points: r.points, ...(r.id === me ? { me: true } : {}) }));
}

/** The latest window the player was in that has ended and whose prize (if any) is not taken. */
async function lastResult(playerId: string, now: number) {
  const { result: snap } = await runIndexedQuery(
    'tournament_player_recent',
    () => entries().where('playerId', '==', playerId).orderBy('joinedAt', 'desc').limit(10).get(),
    () => entries().where('playerId', '==', playerId).limit(40).get(),
  );
  const ended = snap.docs
    .map((d) => entryOf(d.data())!)
    .map((e) => ({ e, w: windowOfId(e.window, schedule) }))
    .filter((x): x is { e: Entry; w: Window } => !!x.w && x.w.endsAt <= now)
    .sort((a, b) => b.w.startsAt - a.w.startsAt);
  const last = ended[0];
  if (!last) return null;
  const rows = await standings(last.w, last.e.group, last.w.endsAt);
  const place = rows.find((r) => r.id === playerId)?.rank ?? 0;
  // A shadowbanned player's isolated bot-only group (negative id) wins nothing.
  const prize = last.e.points > 0 && last.e.group >= 0 ? prizeFor(place) : null;
  const taken = prize ? (await prizes().doc(`${last.w.id}_${playerId}`).get()).exists : false;
  return { window: last.w.id, endedAt: last.w.endsAt, place, points: last.e.points, prize, taken, top: view(rows, playerId) };
}

export const tournamentService = {
  /** Everything the game's tournament page shows, in one answer. */
  async current(playerId: string) {
    const now = Date.now();
    const w = windowAt(now, schedule);
    const next = nextWindow(now, schedule);
    const [curSnap, result] = await Promise.all([
      w ? entries().doc(`${w.id}_${playerId}`).get() : Promise.resolve(null),
      lastResult(playerId, now),
    ]);
    let joined = false;
    let group: ReturnType<typeof view> | null = null;
    let points = 0;
    if (w && curSnap) {
      const e = entryOf(curSnap.data());
      if (e) {
        joined = true;
        points = e.points;
        group = view(await standings(w, e.group, now), playerId);
      }
    }
    return {
      now,
      open: !!w && now < w.endsAt - JOIN_CLOSES_MS,
      window: w,
      next,
      joined,
      points,
      group,
      prizes: PRIZES,
      // The last ended window the player was in: their place, the group at the end, and its
      // prize (null outside the first three) and whether it was taken. The game shows it once
      // and opens the chest while the prize waits.
      result,
    };
  },

  /** Into this window's next group with a free place (once; again it answers the same group). */
  async join(playerId: string, given: { name?: string; avatar?: string; frame?: string }) {
    const now = Date.now();
    const w = windowAt(now, schedule);
    if (!w || now >= w.endsAt - JOIN_CLOSES_MS) throw new AppError(409, 'tournament_closed');
    const ref = entries().doc(`${w.id}_${playerId}`);
    const [profile, hidden] = await Promise.all([profileOf(playerId, given), leaderboardService.isHidden(playerId)]);
    const e = await db.runTransaction(async (tx) => {
      const have = await tx.get(ref);
      if (have.exists) return entryOf(have.data())!;
      // Shadowbanned players are placed in an isolated bot-only group (negative group id)
      // without touching windows/{w.id}.joined so real groups remain clean.
      if (hidden) {
        const entry: Entry = { window: w.id, playerId, group: shadowGroupOf(w.id, playerId), points: 0, lastAt: 0, joinedAt: now, ...profile };
        tx.create(ref, entry);
        return entry;
      }
      const wref = windows().doc(w.id);
      const ws = await tx.get(wref);
      const place = ws.exists ? (ws.get('joined') as number) ?? 0 : 0;
      const entry: Entry = { window: w.id, playerId, group: Math.floor(place / GROUP_SIZE), points: 0, lastAt: 0, joinedAt: now, ...profile };
      tx.set(wref, { joined: place + 1, startsAt: Timestamp.fromMillis(w.startsAt) }, { merge: true });
      tx.create(ref, entry);
      return entry;
    });
    groupCache.delete(`${w.id}|${e.group}`);
    return { window: w, group: view(await standings(w, e.group, now), playerId) };
  },

  /** A level's points, added to the player's in that window (refused if too soon, capped). */
  async score(playerId: string, windowId: string, add: number) {
    const now = Date.now();
    const w = windowOfId(windowId, schedule);
    if (!w || now < w.startsAt || now > w.endsAt + GRACE_MS) throw new AppError(409, 'tournament_closed');
    const ref = entries().doc(`${w.id}_${playerId}`);
    const r = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const e = entryOf(snap.data());
      if (!e) throw new AppError(409, 'not_joined');
      const take = allowedAdd(e.points, e.lastAt, add, now);
      if (take === null) throw new AppError(429, 'too_soon');
      tx.update(ref, { points: FieldValue.increment(take), lastAt: now });
      return { group: e.group, points: e.points + take, taken: take };
    });
    groupCache.delete(`${w.id}|${r.group}`);
    return { window: w.id, points: r.points, taken: r.taken, group: view(await standings(w, r.group, Math.min(now, w.endsAt)), playerId) };
  },

  /** Left a level mid-way: the player's points in the window go back to 0. */
  async forfeit(playerId: string, windowId: string) {
    const now = Date.now();
    const w = windowOfId(windowId, schedule);
    if (!w || now < w.startsAt || now > w.endsAt + GRACE_MS) throw new AppError(409, 'tournament_closed');
    const ref = entries().doc(`${w.id}_${playerId}`);
    const snap = await ref.get();
    const e = entryOf(snap.data());
    if (!e) throw new AppError(409, 'not_joined');
    await ref.update({ points: 0, lastAt: now });
    groupCache.delete(`${w.id}|${e.group}`);
    return { window: w.id, points: 0, group: view(await standings(w, e.group, Math.min(now, w.endsAt)), playerId) };
  },

  /** An ended window's prize, taken once (409 nothing_to_claim / already_claimed). */
  async claim(playerId: string, windowId: string) {
    const now = Date.now();
    const w = windowOfId(windowId, schedule);
    if (!w || now < w.endsAt) throw new AppError(409, 'nothing_to_claim');
    const snap = await entries().doc(`${w.id}_${playerId}`).get();
    const e = entryOf(snap.data());
    // A shadowbanned player's isolated bot-only group (negative id) wins nothing.
    if (!e || e.points <= 0 || e.group < 0) throw new AppError(409, 'nothing_to_claim');
    const rows = await standings(w, e.group, w.endsAt);
    const place = rows.find((r) => r.id === playerId)?.rank ?? 0;
    const prize = prizeFor(place);
    if (!prize) throw new AppError(409, 'nothing_to_claim');
    const ref = prizes().doc(`${w.id}_${playerId}`);
    await db.runTransaction(async (tx) => {
      const have = await tx.get(ref);
      if (have.exists) throw new AppError(409, 'already_claimed');
      tx.create(ref, { window: w.id, playerId, place, prize, at: FieldValue.serverTimestamp() });
    });
    return { window: w.id, place, prize };
  },
};
