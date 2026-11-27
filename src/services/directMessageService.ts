import { config } from '../config';
import { col, db, FieldValue, Timestamp } from '../firebase';
import { AppError } from '../middleware/errorHandler';
import { cleanMessage, isRude } from './chatFilter';
import { Stats } from './profile';
import { normalizeCode, referralService } from './referralService';
import { safetyService } from './safetyService';

/**
 * Direct messages between two players (found by their ID, the invite code): words, and asking
 * the other for a life or coins, which they send with one tap. Their own collections:
 *
 * kingdom_dm_threads/{a}__{b}  (the two ids sorted)  { a, b, updatedAt, lives: {id: n}, coins: {id: n}, askLifeAt: {id: ms}, askCoinsAt: {id: ms} }
 * kingdom_dm_threads/{pair}/messages/{id}             { from, kind: text | life | coins, text, at, helped }
 */
const prefix = config.collections.players.replace(/players$/, '');
const threads = () => db.collection(`${prefix}dm_threads`);

/** One-to-one messages are off for now (only team chat): writing, asking and sending are refused. */
export const DM_ENABLED = false;
const dmOff = () => {
  if (!DM_ENABLED) throw new AppError(403, 'dm_off');
};

export const DM_ASK_MS = 4 * 60 * 60_000;
export const DM_COIN_GIFT = 20;
const SHOWN = 60;

export const pairOf = (x: string, y: string) => (x < y ? `${x}__${y}` : `${y}__${x}`);

async function playerByCode(rawCode: string): Promise<string> {
  const code = normalizeCode(rawCode);
  const invite = code ? await col.invites().doc(code).get() : null;
  const id = invite?.exists ? (invite.get('playerId') as string) : null;
  if (!id) throw new AppError(404, 'player_not_found');
  return id;
}

async function face(playerId: string) {
  const row = await col.leaderboard().doc(playerId).get();
  if (row.exists && !row.get('hidden'))
    return { name: row.get('name') as string, avatar: row.get('avatar') as string, frame: row.get('frame') as string, level: (row.get('level') as number) ?? 1, team: (row.get('team') as string) ?? null, stats: (row.get('stats') as Stats) ?? null };
  const p = await col.players().doc(playerId).get();
  if (!p.exists) throw new AppError(404, 'player_not_found');
  return { name: (p.get('name') as string) ?? 'Player', avatar: (p.get('avatar') as string) ?? 'leo', frame: (p.get('frame') as string) ?? 'gold', level: (p.get('level') as number) ?? 1, team: null, stats: null };
}

/** Words and asks only between friends (both sides' rows say `friend`). */
async function friendsOnly(me: string, other: string) {
  const link = await col.friends().doc(`${me}__${other}`).get();
  if (!link.exists || link.get('status') !== 'friend') throw new AppError(403, 'not_friends');
}

async function exists(playerId: string) {
  const p = await col.players().doc(playerId).get();
  if (!p.exists) throw new AppError(404, 'player_not_found');
}

/**
 * The team chat's unread count for the badge: messages from others newer than `seen` (the newest
 * message time the game has shown, ms; at most 50 counted), as the chat shows them to this player
 * (no blocked player's, no join request unless they may answer it, no words with their chat off).
 * With no `seen` yet (a first look) nothing counts: `lastAt` tells the game where to start from.
 */
async function teamUnreadOf(me: string, teamId: string, role: string, seen: number, blocked: Set<string>, chatOff: boolean): Promise<{ unread: number; lastAt: number }> {
  const msgs = col.teams().doc(teamId).collection('messages');
  const fresh = Number.isFinite(seen) && seen > 0;
  const snap = fresh
    ? await msgs.where('createdAt', '>', Timestamp.fromMillis(seen)).orderBy('createdAt', 'desc').limit(50).get()
    : await msgs.orderBy('createdAt', 'desc').limit(1).get();
  const at = (d: FirebaseFirestore.QueryDocumentSnapshot) => (d.get('createdAt') as FirebaseFirestore.Timestamp)?.toMillis?.() ?? 0;
  const lastAt = snap.empty ? (fresh ? seen : 0) : at(snap.docs[0]);
  if (!fresh) return { unread: 0, lastAt };
  const mayAnswer = role === 'leader' || role === 'coleader';
  const unread = snap.docs.filter((d) => {
    const from = d.get('playerId') as string;
    const kind = d.get('kind') as string;
    if (from === me || blocked.has(from)) return false;
    if (kind === 'joinRequest') return mayAnswer && (d.get('status') ?? 'pending') === 'pending';
    if (kind === 'text' && chatOff) return false;
    return true;
  }).length;
  return { unread, lastAt };
}

export const directMessageService = {
  /** Players by name (starting with what was typed; the hidden left out): at most 10. */
  async search(me: string, raw: string) {
    const key = String(raw || '').trim().toLocaleLowerCase('tr').slice(0, 16);
    if (key.length < 2) throw new AppError(400, 'name_too_short');
    const snap = await col.leaderboard().where('nameLower', '>=', key).where('nameLower', '<', key + '\uf8ff').limit(15).get();
    const players = snap.docs
      .filter((d) => d.id !== me && !d.get('hidden'))
      .slice(0, 10)
      .map((d) => ({ playerId: d.id, name: d.get('name'), avatar: d.get('avatar'), frame: d.get('frame'), level: d.get('level') ?? 1, team: d.get('team') ?? null, stats: d.get('stats') ?? null }));
    return { players };
  },

  /** A player by their ID: their face, level, numbers, and whether they are a friend. */
  async find(me: string, rawCode: string) {
    const other = await playerByCode(rawCode);
    if (other === me) throw new AppError(400, 'own_id');
    const [f, friend] = await Promise.all([face(other), col.friends().doc(`${me}__${other}`).get()]);
    return { player: { playerId: other, code: normalizeCode(rawCode), ...f, friend: friend.exists ? (friend.get('status') as string) : null } };
  },

  /** The conversation with `other`: the last messages, what waits for me, when I can ask again. */
  async read(me: string, other: string) {
    if (other === me) throw new AppError(400, 'own_id');
    await exists(other);
    const ref = threads().doc(pairOf(me, other));
    const [t, msgs, them] = await Promise.all([ref.get(), ref.collection('messages').orderBy('at', 'desc').limit(SHOWN).get(), face(other)]);
    const now = Date.now();
    const askLifeAt = (t.get('askLifeAt')?.[me] as number) ?? 0;
    const askCoinsAt = (t.get('askCoinsAt')?.[me] as number) ?? 0;
    return {
      other: { playerId: other, ...them },
      messages: msgs.docs
        .reverse()
        .map((d) => ({ id: d.id, kind: d.get('kind'), text: d.get('text') ?? '', mine: d.get('from') === me, at: (d.get('at') as FirebaseFirestore.Timestamp)?.toMillis?.() ?? 0, helped: !!d.get('helped') })),
      livesWaiting: (t.get('lives')?.[me] as number) ?? 0,
      coinsWaiting: (t.get('coins')?.[me] as number) ?? 0,
      askLifeInMs: Math.max(0, askLifeAt + DM_ASK_MS - now),
      askCoinsInMs: Math.max(0, askCoinsAt + DM_ASK_MS - now),
    };
  },

  async say(me: string, other: string, raw: string) {
    dmOff();
    if (other === me) throw new AppError(400, 'own_id');
    const text = cleanMessage(raw);
    if (!text) throw new AppError(400, 'empty_message');
    if (isRude(text)) throw new AppError(400, 'message_rude');
    await exists(other);
    await friendsOnly(me, other);
    const ref = threads().doc(pairOf(me, other));
    const [a, b] = me < other ? [me, other] : [other, me];
    await Promise.all([
      // The last word on the thread (who, what, when): the other's inbox (a word that they wrote).
      ref.set({ a, b, updatedAt: Timestamp.now(), lastFrom: me, lastText: text, lastAt: Date.now() }, { merge: true }),
      ref.collection('messages').add({ from: me, kind: 'text', text, at: Timestamp.now(), helped: false }),
    ]);
    return { ok: true };
  },

  /** Asks the other for a life or coins (once every DM_ASK_MS each). */
  async ask(me: string, other: string, kind: 'life' | 'coins') {
    dmOff();
    if (other === me) throw new AppError(400, 'own_id');
    await exists(other);
    await friendsOnly(me, other);
    const ref = threads().doc(pairOf(me, other));
    const field = kind === 'life' ? 'askLifeAt' : 'askCoinsAt';
    const [a, b] = me < other ? [me, other] : [other, me];
    await db.runTransaction(async (tx) => {
      const t = await tx.get(ref);
      const last = (t.get(field)?.[me] as number) ?? 0;
      if (Date.now() - last < DM_ASK_MS) throw new AppError(429, 'ask_too_soon');
      tx.set(ref, { a, b, updatedAt: Timestamp.now(), [field]: { [me]: Date.now() }, lastFrom: me, lastText: kind === 'life' ? 'asked for a life' : 'asked for coins', lastAt: Date.now() }, { merge: true });
      tx.create(ref.collection('messages').doc(), { from: me, kind, text: '', at: Timestamp.now(), helped: false });
    });
    return { ok: true };
  },

  /** Sends what the other asked for in `messageId` (only to their ask, once). */
  async help(me: string, other: string, messageId: string) {
    dmOff();
    const ref = threads().doc(pairOf(me, other));
    const msgRef = ref.collection('messages').doc(messageId);
    return db.runTransaction(async (tx) => {
      const m = await tx.get(msgRef);
      if (!m.exists) throw new AppError(404, 'message_not_found');
      if (m.get('from') !== other) throw new AppError(400, 'not_their_ask');
      const kind = m.get('kind') as string;
      if (kind !== 'life' && kind !== 'coins') throw new AppError(400, 'not_an_ask');
      if (m.get('helped')) throw new AppError(409, 'already_helped');
      const pot = kind === 'life' ? 'lives' : 'coins';
      tx.update(msgRef, { helped: true });
      tx.set(ref, { [pot]: { [other]: FieldValue.increment(kind === 'life' ? 1 : DM_COIN_GIFT) }, updatedAt: Timestamp.now() }, { merge: true });
      return { sent: kind, n: kind === 'life' ? 1 : DM_COIN_GIFT };
    });
  },

  /** What the other sent me: taken (and the thread's count back to 0). */
  async take(me: string, other: string) {
    const ref = threads().doc(pairOf(me, other));
    return db.runTransaction(async (tx) => {
      const t = await tx.get(ref);
      const lives = (t.get('lives')?.[me] as number) ?? 0;
      const coins = (t.get('coins')?.[me] as number) ?? 0;
      if (lives > 0 || coins > 0) tx.set(ref, { lives: { [me]: 0 }, coins: { [me]: 0 } }, { merge: true });
      return { lives, coins };
    });
  },

  /**
   * What came for the player since `since` (ms), for the game's banners: friend requests and
   * words from other players (the newest word of each conversation they wrote last).
   */
  async inbox(me: string, since: number, teamSeen = 0) {
    const after = Number.isFinite(since) && since > 0 ? since : Date.now() - 24 * 3600_000;
    const [asA, asB, reqs, meDoc, member, blockedList] = await Promise.all([
      DM_ENABLED ? threads().where('a', '==', me).limit(200).get() : Promise.resolve(null),
      DM_ENABLED ? threads().where('b', '==', me).limit(200).get() : Promise.resolve(null),
      col.friends().where('owner', '==', me).where('status', '==', 'incoming').limit(50).get(),
      col.players().doc(me).get(),
      col.teamMembers().doc(me).get(),
      safetyService.blocked(me),
    ]);
    // Leaders and co-leaders of a "by request" team: who asked to join it.
    const role = member.exists ? (member.get('role') as string) : '';
    const teamAsks =
      role === 'leader' || role === 'coleader'
        ? (await col.teams().doc(member.get('teamId') as string).collection('requests').limit(50).get()).docs
            .map((d) => ({ playerId: d.id, name: (d.get('name') as string) ?? 'A player', avatar: (d.get('avatar') as string) ?? 'leo', frame: (d.get('frame') as string) ?? 'gold', at: (d.get('at') as FirebaseFirestore.Timestamp)?.toMillis?.() ?? 0 }))
            .filter((r) => r.at > after)
        : [];
    const blocked = new Set(blockedList);
    const words = (DM_ENABLED && asA && asB ? [...asA.docs, ...asB.docs] : [])
      .filter((t) => t.get('lastFrom') && t.get('lastFrom') !== me && ((t.get('lastAt') as number) ?? 0) > after)
      .map((t) => ({ playerId: t.get('lastFrom') as string, text: (t.get('lastText') as string) ?? '', at: t.get('lastAt') as number }));
    const waiting = reqs.docs
      .map((d) => ({ playerId: d.get('other') as string, at: (d.get('at') as FirebaseFirestore.Timestamp)?.toMillis?.() ?? 0 }))
      .filter((r) => !blocked.has(r.playerId));
    const requests = waiting.filter((r) => r.at > after);
    const [team, gifts] = await Promise.all([
      member.exists ? teamUnreadOf(me, member.get('teamId') as string, role, teamSeen, blocked, !!meDoc.get('chatOff')) : Promise.resolve({ unread: 0, lastAt: 0 }),
      col.lifeInbox().doc(me).get(),
    ]);
    // Their names (the board's row, else the player's own).
    const ids = [...new Set([...words.map((w) => w.playerId), ...requests.map((r) => r.playerId)])];
    const faces = new Map<string, { name: string; avatar: string; frame: string }>();
    await Promise.all(
      ids.map(async (id) => {
        const f = await face(id).catch(() => null);
        faces.set(id, { name: f?.name ?? 'A player', avatar: f?.avatar ?? 'leo', frame: f?.frame ?? 'gold' });
      }),
    );
    return {
      now: Date.now(),
      requests: requests.map((r) => ({ ...r, ...faces.get(r.playerId) })),
      messages: words.sort((x, y) => x.at - y.at).map((w) => ({ ...w, ...faces.get(w.playerId) })),
      teamRequests: teamAsks,
      // The answer to the player's own request to join a team (once, when it is new).
      teamAnswer: (() => {
        const a = meDoc.get('teamAnswer') as { teamId: string; name: string; accepted: boolean; at: number } | undefined;
        return a && a.at > after ? a : null;
      })(),
      pendingTeam: (meDoc.get('pendingTeam') as { teamId: string; name: string } | undefined) ?? null,
      // The badges: every friend request still waiting (when each came: the game counts those it
      // has not shown yet), and the team chat's messages from others since the game last showed it.
      friendRequestsAt: waiting.map((r) => r.at),
      teamUnread: team.unread,
      teamLastAt: team.lastAt,
      // Lives and coins teammates sent, waiting to be taken (the game takes them wherever it is).
      // The player's team and role now: the game sees a change (made a leader, removed) wherever it is.
      myTeam: member.exists ? { teamId: member.get('teamId') as string, role } : null,
      livesWaiting: (gifts.get('lives') as number) ?? 0,
      coinsWaiting: (gifts.get('coins') as number) ?? 0,
    };
  },

  /** The player's own ID (to show on Add Friend). */
  async myCode(me: string) {
    return { code: await referralService.codeOf(me) };
  },
};
