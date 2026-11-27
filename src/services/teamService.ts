import { z } from 'zod';
import { col, db, FieldValue, Timestamp } from '../firebase';
import { AppError } from '../middleware/errorHandler';
import { runIndexedQuery } from '../utils/indexedQuery';
import { logger } from '../utils/logger';
import { TtlCache } from '../utils/ttlCache';
import { cleanMessage, hidePersonal, isRude, nameIsRude } from './chatFilter';
import { cleanName, Stats } from './profile';
import { playerService } from './playerService';
import { safetyService } from './safetyService';
import { pushService } from './pushService';

/**
 * Teams: a name, a crest, a short description, who may join (open, or by request: the leader
 * or a co-leader lets them in), the level and crowns a member needs, at most MAX_MEMBERS. Each
 * player is in one team at most. The team's score is its legitimate (non-hidden) members'
 * levels added up, kept on the team as they change (join, leave, kick, hide, level rise).
 *
 * kingdom_teams/{teamId}                 name, nameLower, description, crest, type, minLevel,
 *                                        minCrowns, members, score, leaderId, createdAt, activeAt
 * kingdom_teams/{teamId}/messages/{id}   kind (text | life | coins | join | leave | joinRequest),
 *                                        playerId, name, avatar, frame, text, helpers[], createdAt
 * kingdom_teams/{teamId}/requests/{pid}  a "by request" team's waiting asker: messageId, level, name, at
 * kingdom_team_members/{playerId}        teamId, role (leader | coleader | knight), level,
 *                                        countedScore, helps, name, avatar, frame, joinedAt
 * kingdom_life_inbox/{playerId}          lives, coins (sent by teammates, not taken yet)
 */
export const MAX_MEMBERS = 50;
export const CREATE_COST = 100;
/** The level a player must reach to make a team (joining one has no such bar, only the team's own). */
export const CREATE_FROM_LEVEL = 80;
export const LIFE_HELPS = 5;
export const HELP_COINS = 5;
export const ASK_LIFE_COOLDOWN_MS = 4 * 60 * 60 * 1000;
export const COIN_HELPS = 5;
export const COIN_GIFT = 20;
export const ASK_COINS_COOLDOWN_MS = 8 * 60 * 60 * 1000;
export const CREST_COUNT = 48;
/** Daily cap on helps per player (stops leave/rejoin +5 coin farming across open teams). */
export const MAX_HELPS_PER_DAY = 30;
/** Daily cap on team creations per player (stops raw-API team spam). */
export const MAX_TEAM_CREATES_PER_DAY = 3;
const MESSAGES_KEPT = 60;

export const createSchema = z.object({
  name: z.string().min(1).max(40),
  description: z.string().max(160).optional().default(''),
  crest: z.number().int().min(0).max(CREST_COUNT - 1),
  type: z.enum(['open', 'request']).default('open'),
  minLevel: z.number().int().min(0).max(100000).default(0),
  minCrowns: z.number().int().min(0).max(1000000).default(0),
});

export const editSchema = z
  .object({
    description: z.string().max(160).optional(),
    crest: z.number().int().min(0).max(CREST_COUNT - 1).optional(),
    type: z.enum(['open', 'request']).optional(),
    minLevel: z.number().int().min(0).max(100000).optional(),
    minCrowns: z.number().int().min(0).max(1000000).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'empty_edit');

export type Role = 'leader' | 'coleader' | 'knight';

export interface TeamDoc {
  name: string;
  nameLower: string;
  description: string;
  crest: number;
  type: 'open' | 'request';
  minLevel: number;
  minCrowns: number;
  members: number;
  score: number;
  leaderId: string;
  /** The founder's country ("TR"), for the country's team board; null when not known. */
  country?: string | null;
  createdAt: FirebaseFirestore.Timestamp;
  activeAt: FirebaseFirestore.Timestamp;
}

export interface MemberDoc {
  teamId: string;
  role: Role;
  level: number;
  /** How much of this member's level is currently counted in the team's score (0 when shadowbanned). */
  countedScore?: number;
  helps: number;
  name: string;
  avatar: string;
  frame: string;
  joinedAt: FirebaseFirestore.Timestamp;
}

export interface MessageOut {
  id: string;
  kind: 'text' | 'life' | 'coins' | 'join' | 'leave' | 'joinRequest';
  /** A join request's state: pending, accepted, declined or cancelled. */
  status?: string;
  playerId: string;
  name: string;
  avatar: string;
  frame: string;
  text: string;
  helps: number;
  helpedByMe: boolean;
  mine: boolean;
  at: number;
}

/** Pure role permission helpers (also unit-tested). */
export const canAnswerRequest = (role: Role): boolean => role === 'leader' || role === 'coleader';
export const canEditTeam = (role: Role): boolean => role === 'leader' || role === 'coleader';
export const canKick = (actor: Role, target: Role): boolean =>
  (actor === 'leader' && target !== 'leader') || (actor === 'coleader' && target === 'knight');

const todayUtc = () => new Date().toISOString().slice(0, 10);

export function dailyQuotaExceeded(storedDay: unknown, storedCount: unknown, today: string, limit: number): boolean {
  const n = storedDay === today && typeof storedCount === 'number' ? storedCount : 0;
  return n >= limit;
}

/** A team's public face: what the lists and the info page show. */
export function teamOut(id: string, t: TeamDoc) {
  const activeHours = (Date.now() - (t.activeAt?.toMillis?.() ?? 0)) / 3_600_000;
  return {
    id,
    name: t.name,
    description: t.description,
    crest: t.crest,
    type: t.type,
    minLevel: t.minLevel,
    minCrowns: t.minCrowns,
    members: t.members,
    capacity: MAX_MEMBERS,
    score: Math.max(0, t.score ?? 0),
    country: t.country ?? null,
    // Activity from the last message or member change: high within a day, medium within a week.
    activity: activeHours < 24 ? 'high' : activeHours < 24 * 7 ? 'medium' : 'low',
  };
}

const ROLE_ORDER: Record<Role, number> = { leader: 0, coleader: 1, knight: 2 };

const listCache = new TtlCache<ReturnType<typeof teamOut>[]>(30_000, 60);

/**
 * Sets or clears the team name on an EXISTING leaderboard row only.
 * Never creates a phantom leaderboard document for a player who has not submitted a level yet.
 */
function boardTeam(tx: FirebaseFirestore.Transaction, boardSnap: FirebaseFirestore.DocumentSnapshot, name: string | null) {
  if (!boardSnap.exists) return;
  tx.update(boardSnap.ref, { team: name ?? FieldValue.delete() });
}

async function profileOf(playerId: string) {
  const p = await playerService.get(playerId);
  if (!p) throw new AppError(404, 'player_not_found');
  if (p.banned) throw new AppError(403, 'banned');
  return { name: p.name, avatar: p.avatar, frame: p.frame, level: p.level ?? 1 };
}

/** Cleans up subcollections (requests + messages) and waiting players' pendingTeam after a team is closed. */
async function cleanupClosedTeam(teamId: string): Promise<void> {
  const teamRef = col.teams().doc(teamId);
  try {
    const reqs = await teamRef.collection('requests').limit(200).get();
    if (!reqs.empty) {
      // Only players whose pendingTeam still points at THIS team, and only existing player docs
      // (update, never set: a deleted account gets no ghost player doc).
      const players = await db.getAll(...reqs.docs.map((d) => col.players().doc(d.id)));
      const batch = db.batch();
      let n = 0;
      for (const p of players) {
        if (!p.exists) continue;
        const pending = p.get('pendingTeam') as { teamId?: string } | undefined;
        if (pending?.teamId !== teamId) continue;
        batch.update(p.ref, { pendingTeam: FieldValue.delete() });
        n++;
      }
      if (n > 0) await batch.commit().catch(() => undefined);
    }
    await db.recursiveDelete(teamRef);
  } catch (err) {
    logger.warn({ err, teamId }, 'team: cleanup of closed team failed');
  }
}

/** Every waiting join request of a team: deleted, its chat card marked cancelled, the asker's pendingTeam cleared. */
async function cancelAllRequests(teamId: string): Promise<number> {
  const teamRef = col.teams().doc(teamId);
  const reqs = await teamRef.collection('requests').limit(400).get();
  if (reqs.empty) return 0;
  const players = await db.getAll(...reqs.docs.map((d) => col.players().doc(d.id)));
  const batch = db.batch();
  for (const d of reqs.docs) {
    batch.delete(d.ref);
    const msgId = d.get('messageId') as string | undefined;
    if (msgId) batch.set(teamRef.collection('messages').doc(msgId), { status: 'cancelled' }, { merge: true });
  }
  for (const p of players) {
    if (p.exists && (p.get('pendingTeam') as { teamId?: string } | undefined)?.teamId === teamId) batch.update(p.ref, { pendingTeam: FieldValue.delete() });
  }
  await batch.commit();
  return reqs.size;
}

/** A brand-new account may not write yet (a spam bot's first minutes); a player's chat is off; the same words twice in a row are refused. */
export const NEW_ACCOUNT_CHAT_MS = 10 * 60_000;
export const SAME_MESSAGE_MS = 60_000;

async function chatGuard(playerId: string, text: string) {
  const ref = col.players().doc(playerId);
  const p = await ref.get();
  const created = (p.get('createdAt') as FirebaseFirestore.Timestamp | undefined)?.toMillis?.() ?? 0;
  if (created && Date.now() - created < NEW_ACCOUNT_CHAT_MS) throw new AppError(403, 'too_new_to_chat');
  if (p.get('chatOff')) throw new AppError(403, 'chat_off');
  const last = (p.get('lastChat') as string | undefined) ?? '';
  const lastAt = (p.get('lastChatAt') as number | undefined) ?? 0;
  const same = last.toLocaleLowerCase('tr') === text.toLocaleLowerCase('tr');
  if (same && Date.now() - lastAt < SAME_MESSAGE_MS) throw new AppError(429, 'duplicate_message');
  await ref.update({ lastChat: text.slice(0, 200), lastChatAt: Date.now() });
}

export const teamService = {
  /** The player's membership, or null. */
  async memberOf(playerId: string): Promise<MemberDoc | null> {
    const snap = await col.teamMembers().doc(playerId).get();
    return snap.exists ? (snap.data() as MemberDoc) : null;
  },

  /** Teams with room, the busiest first (the "Join" list). */
  async recommended(): Promise<ReturnType<typeof teamOut>[]> {
    return listCache.getOrLoad('recommended', async () => {
      const snap = await col.teams().where('members', '<', MAX_MEMBERS).orderBy('members', 'desc').limit(30).get();
      return snap.docs.map((d) => teamOut(d.id, d.data() as TeamDoc));
    });
  },

  /** The team board, the highest score first: the world's, or one country's ("TR"). */
  async top(country?: string): Promise<ReturnType<typeof teamOut>[]> {
    const cc = country && /^[A-Z]{2}$/.test(country) ? country : null;
    return listCache.getOrLoad(cc ? 'top_' + cc : 'top', async () => {
      if (!cc) {
        const snap = await col.teams().orderBy('score', 'desc').limit(100).get();
        return snap.docs.map((d) => teamOut(d.id, d.data() as TeamDoc));
      }
      const { result } = await runIndexedQuery(
        'teams_country_score',
        async () => {
          const snap = await col.teams().where('country', '==', cc).orderBy('score', 'desc').limit(100).get();
          return snap.docs.map((d) => teamOut(d.id, d.data() as TeamDoc));
        },
        async () => {
          const snap = await col.teams().where('country', '==', cc).limit(1000).get();
          return snap.docs
            .map((d) => teamOut(d.id, d.data() as TeamDoc))
            .sort((a, b) => b.score - a.score)
            .slice(0, 100);
        },
      );
      return result;
    });
  },

  /** Teams whose name starts with the text (case-insensitive). */
  async search(q: string): Promise<ReturnType<typeof teamOut>[]> {
    const key = cleanName(q).toLocaleLowerCase('tr');
    if (key.length < 2) return [];
    const snap = await col.teams().where('nameLower', '>=', key).where('nameLower', '<', key + '\uf8ff').limit(20).get();
    return snap.docs.map((d) => teamOut(d.id, d.data() as TeamDoc));
  },

  /** A team and its members (the info page). */
  async info(teamId: string) {
    const snap = await col.teams().doc(teamId).get();
    if (!snap.exists) throw new AppError(404, 'team_not_found');
    const members = await col.teamMembers().where('teamId', '==', teamId).limit(MAX_MEMBERS).get();
    // Their profile's numbers (the leaderboard rows), for their card.
    const board = members.empty ? [] : await col.leaderboard().firestore.getAll(...members.docs.map((d) => col.leaderboard().doc(d.id)));
    const statsOf = new Map(board.filter((b) => b.exists && b.get('stats')).map((b) => [b.id, b.get('stats') as Stats]));
    const rows = members.docs
      .map((d) => {
        const m = d.data() as MemberDoc;
        // A sample team's member (seedService) has no board row: their numbers are on the member.
        const stats = statsOf.get(d.id) ?? (m as MemberDoc & { stats?: Stats }).stats;
        return { playerId: d.id, name: m.name, avatar: m.avatar, frame: m.frame, role: m.role, level: m.level, helps: m.helps ?? 0, ...(stats ? { stats } : {}) };
      })
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || b.level - a.level);
    return { team: teamOut(snap.id, snap.data() as TeamDoc), members: rows };
  },

  async create(playerId: string, input: z.infer<typeof createSchema>) {
    const me = await profileOf(playerId);
    if (me.level < CREATE_FROM_LEVEL) throw new AppError(403, 'create_level_too_low');
    const name = cleanName(input.name);
    // A team's name and description are seen by everyone: no rude word, no personal information.
    if (nameIsRude(name)) throw new AppError(400, 'team_name_rude');
    if ((input.description ?? '').split(/\s+/).some((w) => isRude(w)) || hidePersonal(input.description ?? '') !== (input.description ?? '')) throw new AppError(400, 'team_description_rude');
    const nameLower = name.toLocaleLowerCase('tr');
    const taken = await col.teams().where('nameLower', '==', nameLower).limit(1).get();
    if (!taken.empty) throw new AppError(409, 'team_name_taken');
    const teamRef = col.teams().doc();
    const now = Timestamp.now();
    const today = todayUtc();
    await col.teams().firestore.runTransaction(async (tx) => {
      const playerRef = col.players().doc(playerId);
      const boardRef = col.leaderboard().doc(playerId);
      const [mine, playerSnap, boardSnap] = await Promise.all([tx.get(col.teamMembers().doc(playerId)), tx.get(playerRef), tx.get(boardRef)]);
      if (mine.exists) throw new AppError(409, 'already_in_team');
      if (dailyQuotaExceeded(playerSnap.get('teamCreateDay'), playerSnap.get('teamCreateN'), today, MAX_TEAM_CREATES_PER_DAY)) {
        throw new AppError(429, 'team_create_limit');
      }
      const hidden = boardSnap.exists && !!boardSnap.get('hidden');
      const contrib = hidden ? 0 : me.level;
      const country = (boardSnap.exists ? (boardSnap.get('country') as string | undefined) : undefined) ?? null;
      const sameDay = playerSnap.get('teamCreateDay') === today;
      tx.set(playerRef, { teamCreateDay: today, teamCreateN: sameDay ? ((playerSnap.get('teamCreateN') as number) ?? 0) + 1 : 1, pendingTeam: FieldValue.delete() }, { merge: true });
      tx.create(teamRef, {
        name,
        nameLower,
        description: cleanMessage(input.description ?? '').slice(0, 160),
        crest: input.crest,
        type: input.type,
        minLevel: input.minLevel,
        minCrowns: input.minCrowns,
        members: 1,
        score: contrib,
        leaderId: playerId,
        country,
        createdAt: now,
        activeAt: now,
      } satisfies TeamDoc);
      boardTeam(tx, boardSnap, name);
      tx.create(col.teamMembers().doc(playerId), { teamId: teamRef.id, role: 'leader', level: me.level, countedScore: contrib, helps: 0, name: me.name, avatar: me.avatar, frame: me.frame, joinedAt: now } satisfies MemberDoc);
    });
    listCache.clear();
    return { id: teamRef.id };
  },

  /** Joining: at once in an open team; a "by request" team gets a request card in its chat instead. */
  async join(playerId: string, teamId: string): Promise<{ requested: boolean }> {
    const me = await profileOf(playerId);
    const teamRef = col.teams().doc(teamId);
    const now = Timestamp.now();
    const requested = await col.teams().firestore.runTransaction(async (tx) => {
      const reqRef = teamRef.collection('requests').doc(playerId);
      const playerRef = col.players().doc(playerId);
      const boardRef = col.leaderboard().doc(playerId);
      const [team, mine, waiting, meDoc, boardSnap] = await Promise.all([
        tx.get(teamRef),
        tx.get(col.teamMembers().doc(playerId)),
        tx.get(reqRef),
        tx.get(playerRef),
        tx.get(boardRef),
      ]);
      if (!team.exists) throw new AppError(404, 'team_not_found');
      if (mine.exists) throw new AppError(409, 'already_in_team');
      const t = team.data() as TeamDoc;
      if (t.members >= MAX_MEMBERS) throw new AppError(409, 'team_full');
      if (me.level < t.minLevel) throw new AppError(403, 'level_too_low');
      if (t.type === 'request') {
        // Asked already: it waits as it is.
        if (waiting.exists) return true;
        // One request at a time: only blocks if BOTH the other team AND its request doc still exist.
        const pending = meDoc.get('pendingTeam') as { teamId: string; name?: string } | undefined;
        if (pending && pending.teamId !== teamId) {
          const otherTeamRef = col.teams().doc(pending.teamId);
          const [otherTeam, otherReq] = await Promise.all([tx.get(otherTeamRef), tx.get(otherTeamRef.collection('requests').doc(playerId))]);
          if (otherTeam.exists && otherReq.exists) {
            throw new AppError(409, 'request_pending', undefined, { team: pending.name ?? null });
          }
        }
        tx.set(playerRef, { pendingTeam: { teamId, name: t.name, at: now } }, { merge: true });
        const msgRef = teamRef.collection('messages').doc();
        tx.create(msgRef, { kind: 'joinRequest', playerId, name: me.name, avatar: me.avatar, frame: me.frame, text: `Level ${me.level}`, status: 'pending', helpers: [], createdAt: now });
        tx.create(reqRef, { messageId: msgRef.id, level: me.level, name: me.name, avatar: me.avatar, frame: me.frame, at: now });
        return true;
      }
      const hidden = boardSnap.exists && !!boardSnap.get('hidden');
      const contrib = hidden ? 0 : me.level;
      tx.update(teamRef, { members: FieldValue.increment(1), score: FieldValue.increment(contrib), activeAt: now });
      boardTeam(tx, boardSnap, t.name);
      tx.create(col.teamMembers().doc(playerId), { teamId, role: 'knight', level: me.level, countedScore: contrib, helps: 0, name: me.name, avatar: me.avatar, frame: me.frame, joinedAt: now } satisfies MemberDoc);
      tx.create(teamRef.collection('messages').doc(), { kind: 'join', playerId, name: me.name, avatar: me.avatar, frame: me.frame, text: '', helpers: [], createdAt: now });
      tx.set(playerRef, { pendingTeam: FieldValue.delete() }, { merge: true });
      return false;
    });
    if (!requested) listCache.clear();
    return { requested };
  },

  /** Player cancels their own waiting join request so they are free to apply elsewhere. */
  async cancelRequest(playerId: string): Promise<{ cancelled: boolean }> {
    const playerRef = col.players().doc(playerId);
    const cancelled = await col.teams().firestore.runTransaction(async (tx) => {
      const meDoc = await tx.get(playerRef);
      const pending = meDoc.get('pendingTeam') as { teamId?: string } | undefined;
      if (!pending?.teamId) return false;
      const teamRef = col.teams().doc(pending.teamId);
      const reqRef = teamRef.collection('requests').doc(playerId);
      const req = await tx.get(reqRef);
      tx.set(playerRef, { pendingTeam: FieldValue.delete() }, { merge: true });
      if (req.exists) {
        const msgId = req.get('messageId') as string | undefined;
        tx.delete(reqRef);
        if (msgId) tx.set(teamRef.collection('messages').doc(msgId), { status: 'cancelled' }, { merge: true });
        return true;
      }
      return false;
    });
    return { cancelled };
  },

  /** Leader or co-leader answers a join request to their team: in (if there is room), or not. */
  async answerRequest(byId: string, askerId: string, accept: boolean): Promise<{ joined: boolean }> {
    const by = await this.memberOf(byId);
    if (!by) throw new AppError(404, 'not_in_team');
    if (!canAnswerRequest(by.role)) throw new AppError(403, 'not_team_leader');
    const teamRef = col.teams().doc(by.teamId);
    const reqRef = teamRef.collection('requests').doc(askerId);
    const asker = accept ? await profileOf(askerId) : null;
    const now = Timestamp.now();
    const joined = await col.teams().firestore.runTransaction(async (tx) => {
      const boardRef = col.leaderboard().doc(askerId);
      const [req, team, theirs, boardSnap] = await Promise.all([tx.get(reqRef), tx.get(teamRef), tx.get(col.teamMembers().doc(askerId)), tx.get(boardRef)]);
      if (!req.exists) throw new AppError(404, 'request_not_found');
      const msgRef = teamRef.collection('messages').doc(req.get('messageId') as string);
      tx.delete(reqRef);
      const answer = (accepted: boolean) =>
        tx.set(col.players().doc(askerId), { pendingTeam: FieldValue.delete(), teamAnswer: { teamId: by.teamId, name: (team.get('name') as string) ?? '', accepted, at: Date.now() } }, { merge: true });
      if (!accept) {
        tx.set(msgRef, { status: 'declined' }, { merge: true });
        answer(false);
        return false;
      }
      const t = team.data() as TeamDoc;
      // In another team meanwhile, or no room: the request goes.
      if (theirs.exists) {
        tx.set(msgRef, { status: 'taken' }, { merge: true });
        tx.set(col.players().doc(askerId), { pendingTeam: FieldValue.delete() }, { merge: true });
        return false;
      }
      if (t.members >= MAX_MEMBERS) throw new AppError(409, 'team_full');
      const hidden = boardSnap.exists && !!boardSnap.get('hidden');
      const contrib = hidden ? 0 : asker!.level;
      tx.set(msgRef, { status: 'accepted' }, { merge: true });
      answer(true);
      tx.update(teamRef, { members: FieldValue.increment(1), score: FieldValue.increment(contrib), activeAt: now });
      boardTeam(tx, boardSnap, t.name);
      tx.create(col.teamMembers().doc(askerId), { teamId: by.teamId, role: 'knight', level: asker!.level, countedScore: contrib, helps: 0, name: asker!.name, avatar: asker!.avatar, frame: asker!.frame, joinedAt: now } satisfies MemberDoc);
      tx.create(teamRef.collection('messages').doc(), { kind: 'join', playerId: askerId, name: asker!.name, avatar: asker!.avatar, frame: asker!.frame, text: '', helpers: [], createdAt: now });
      return true;
    });
    if (joined) listCache.clear();
    return { joined };
  },

  /** Leaving: the last member out closes the team; a leader leaving hands the lead to the highest active member inside the transaction. */
  async leave(playerId: string) {
    const memberRef = col.teamMembers().doc(playerId);
    const mine = await memberRef.get();
    if (!mine.exists) throw new AppError(404, 'not_in_team');
    const pre = mine.data() as MemberDoc;
    const teamRef = col.teams().doc(pre.teamId);
    const now = Timestamp.now();
    let closedTeamId: string | null = null;
    // Candidate heirs are read outside, their live membership checked inside the transaction.
    // First try: the best 5 (only when a leader leaves). If none is still in the team (they all left
    // meanwhile, or this player became leader meanwhile), retry with every member; only when no
    // other live member is found at all does the team close, so it is never left leaderless and
    // never deleted under members still in it.
    const fetchCandidates = async (all: boolean): Promise<{ ids: string[]; complete: boolean }> => {
      const others = await col.teamMembers().where('teamId', '==', pre.teamId).limit(MAX_MEMBERS).get();
      const sorted = others.docs
        .filter((d) => d.id !== playerId)
        .map((d) => ({ id: d.id, m: d.data() as MemberDoc }))
        .sort((a, b) => ROLE_ORDER[a.m.role] - ROLE_ORDER[b.m.role] || b.m.level - a.m.level)
        .map((x) => x.id);
      return { ids: all ? sorted : sorted.slice(0, 5), complete: all || sorted.length <= 5 };
    };
    const NEED_ALL = 'leave_need_all_candidates';
    for (let attempt = 0; attempt < 2; attempt++) {
      const last = attempt === 1;
      const fetched = pre.role === 'leader' || last ? await fetchCandidates(last) : { ids: [], complete: false };
      const candidateIds = fetched.ids;
      try {
        await col.teams().firestore.runTransaction(async (tx) => {
          const boardRef = col.leaderboard().doc(playerId);
          const [liveMine, team, boardSnap, ...heirSnaps] = await Promise.all([
            tx.get(memberRef),
            tx.get(teamRef),
            tx.get(boardRef),
            ...candidateIds.map((id) => tx.get(col.teamMembers().doc(id))),
          ]);
          if (!liveMine.exists) throw new AppError(404, 'not_in_team');
          const m = liveMine.data() as MemberDoc;
          if (!team.exists) {
            tx.delete(memberRef);
            boardTeam(tx, boardSnap, null);
            return;
          }
          const t = team.data() as TeamDoc;
          const validHeir = m.role === 'leader' ? heirSnaps.find((s) => s.exists && s.get('teamId') === m.teamId) : undefined;
          // A leader with no live heir among a partial list: look at everyone before deciding.
          if (m.role === 'leader' && !validHeir && !fetched.complete) throw new Error(NEED_ALL);
          const newMembers = Math.max(0, t.members - 1);
          const othersRemain = m.role === 'leader' ? !!validHeir : newMembers > 0;
          tx.delete(memberRef);
          boardTeam(tx, boardSnap, null);
          if (!othersRemain) {
            tx.delete(teamRef);
            closedTeamId = m.teamId;
            return;
          }
          const sub = Math.max(0, m.countedScore ?? m.level ?? 0);
          const update: Record<string, unknown> = { members: Math.max(1, newMembers), score: Math.max(0, (t.score ?? 0) - sub), activeAt: now };
          if (validHeir) {
            update.leaderId = validHeir.id;
            tx.update(validHeir.ref, { role: 'leader' });
          }
          tx.update(teamRef, update);
          tx.create(teamRef.collection('messages').doc(), { kind: 'leave', playerId, name: m.name, avatar: m.avatar, frame: m.frame, text: '', helpers: [], createdAt: now });
        });
        break;
      } catch (err) {
        if (err instanceof Error && err.message === NEED_ALL && !last) continue;
        throw err;
      }
    }
    listCache.clear();
    if (closedTeamId) void cleanupClosedTeam(closedTeamId);
  },

  /** Leader (kicks coleader/knight) or co-leader (kicks knight) removes a member from the team. */
  async kick(byId: string, targetId: string): Promise<void> {
    if (byId === targetId) throw new AppError(400, 'cannot_kick_self');
    const byRef = col.teamMembers().doc(byId);
    const targetRef = col.teamMembers().doc(targetId);
    const byPre = await byRef.get();
    if (!byPre.exists) throw new AppError(404, 'not_in_team');
    const teamId = byPre.get('teamId') as string;
    const teamRef = col.teams().doc(teamId);
    const now = Timestamp.now();
    await col.teams().firestore.runTransaction(async (tx) => {
      const targetBoardRef = col.leaderboard().doc(targetId);
      const [bySnap, targetSnap, teamSnap, targetBoardSnap] = await Promise.all([tx.get(byRef), tx.get(targetRef), tx.get(teamRef), tx.get(targetBoardRef)]);
      if (!bySnap.exists) throw new AppError(404, 'not_in_team');
      const actor = bySnap.data() as MemberDoc;
      if (!targetSnap.exists || targetSnap.get('teamId') !== actor.teamId) throw new AppError(404, 'member_not_found');
      const target = targetSnap.data() as MemberDoc;
      if (!canKick(actor.role, target.role)) throw new AppError(403, 'insufficient_role');
      tx.delete(targetRef);
      boardTeam(tx, targetBoardSnap, null);
      if (teamSnap.exists) {
        const t = teamSnap.data() as TeamDoc;
        const sub = Math.max(0, target.countedScore ?? target.level ?? 0);
        tx.update(teamRef, { members: Math.max(1, t.members - 1), score: Math.max(0, (t.score ?? 0) - sub), activeAt: now });
        tx.create(teamRef.collection('messages').doc(), { kind: 'leave', playerId: targetId, name: target.name, avatar: target.avatar, frame: target.frame, text: '', helpers: [], createdAt: now });
      }
    });
    listCache.clear();
  },

  /** Leader promotes/demotes a member (`coleader` | `knight`) or transfers leadership (`leader`). */
  async setRole(byId: string, targetId: string, role: Role): Promise<{ role: Role }> {
    if (byId === targetId) throw new AppError(400, 'cannot_change_own_role');
    const byRef = col.teamMembers().doc(byId);
    const targetRef = col.teamMembers().doc(targetId);
    const byPre = await byRef.get();
    if (!byPre.exists) throw new AppError(404, 'not_in_team');
    const teamId = byPre.get('teamId') as string;
    const teamRef = col.teams().doc(teamId);
    await col.teams().firestore.runTransaction(async (tx) => {
      const [bySnap, targetSnap, teamSnap] = await Promise.all([tx.get(byRef), tx.get(targetRef), tx.get(teamRef)]);
      if (!bySnap.exists) throw new AppError(404, 'not_in_team');
      const actor = bySnap.data() as MemberDoc;
      if (actor.role !== 'leader') throw new AppError(403, 'not_team_leader');
      if (!targetSnap.exists || targetSnap.get('teamId') !== actor.teamId) throw new AppError(404, 'member_not_found');
      if (!teamSnap.exists) throw new AppError(404, 'team_not_found');
      if (role === 'leader') {
        tx.update(byRef, { role: 'coleader' });
        tx.update(targetRef, { role: 'leader' });
        tx.update(teamRef, { leaderId: targetId });
      } else {
        tx.update(targetRef, { role });
      }
    });
    return { role };
  },

  /** Leader or co-leader edits description, crest, join type, minLevel or minCrowns. */
  async edit(byId: string, input: z.infer<typeof editSchema>) {
    const by = await this.memberOf(byId);
    if (!by) throw new AppError(404, 'not_in_team');
    if (!canEditTeam(by.role)) throw new AppError(403, 'not_team_leader');
    const update: Record<string, unknown> = {};
    if (input.description !== undefined) {
      if (input.description.split(/\s+/).some((w) => isRude(w)) || hidePersonal(input.description) !== input.description) {
        throw new AppError(400, 'team_description_rude');
      }
      update.description = cleanMessage(input.description).slice(0, 160);
    }
    if (input.crest !== undefined) update.crest = input.crest;
    if (input.type !== undefined) update.type = input.type;
    if (input.minLevel !== undefined) update.minLevel = input.minLevel;
    if (input.minCrowns !== undefined) update.minCrowns = input.minCrowns;
    const teamRef = col.teams().doc(by.teamId);
    try {
      await teamRef.update(update);
    } catch (err) {
      // The team was closed meanwhile (gRPC 5 NOT_FOUND): a 404, not a 500.
      if ((err as { code?: unknown })?.code === 5) throw new AppError(404, 'team_not_found');
      throw err;
    }
    listCache.clear();
    const fresh = await teamRef.get();
    return { team: teamOut(fresh.id, fresh.data() as TeamDoc) };
  },

  /** The last messages of the player's team, oldest first, and whether a life/coins may be asked for. */
  async messages(playerId: string) {
    const m = await this.memberOf(playerId);
    if (!m) throw new AppError(404, 'not_in_team');
    const [snap, blocked, meDoc, inbox] = await Promise.all([
      col.teams().doc(m.teamId).collection('messages').orderBy('createdAt', 'desc').limit(MESSAGES_KEPT).get(),
      safetyService.blocked(playerId),
      col.players().doc(playerId).get(),
      col.lifeInbox().doc(playerId).get(),
    ]);
    const chatOff = !!meDoc.get('chatOff');
    const canSeeRequests = canAnswerRequest(m.role);
    const rows: MessageOut[] = snap.docs
      .filter((d) => d.get('kind') !== 'joinRequest' || canSeeRequests)
      // A blocked player's words never show (on any device); with chat off, no one else's words do.
      .filter((d) => d.get('playerId') === playerId || !blocked.includes(d.get('playerId')))
      .filter((d) => !chatOff || d.get('kind') !== 'text' || d.get('playerId') === playerId)
      .map((d) => {
        const x = d.data();
        const helpers = (x.helpers as string[]) ?? [];
        return {
          id: d.id,
          kind: x.kind,
          playerId: x.playerId,
          name: x.name,
          avatar: x.avatar,
          frame: x.frame,
          text: x.text ?? '',
          helps: helpers.length,
          helpedByMe: helpers.includes(playerId),
          mine: x.playerId === playerId,
          at: (x.createdAt as FirebaseFirestore.Timestamp)?.toMillis?.() ?? 0,
          ...(x.status ? { status: x.status as string } : {}),
        } satisfies MessageOut;
      })
      .reverse();
    const askAt = (meDoc.get('askLifeAt') as FirebaseFirestore.Timestamp | undefined)?.toMillis() ?? 0;
    const coinsAt = (meDoc.get('askCoinsAt') as FirebaseFirestore.Timestamp | undefined)?.toMillis() ?? 0;
    return {
      teamId: m.teamId,
      role: m.role,
      chatOff,
      messages: rows,
      askLifeInMs: Math.max(0, askAt + ASK_LIFE_COOLDOWN_MS - Date.now()),
      askCoinsInMs: Math.max(0, coinsAt + ASK_COINS_COOLDOWN_MS - Date.now()),
      livesWaiting: (inbox.get('lives') as number) ?? 0,
      coinsWaiting: (inbox.get('coins') as number) ?? 0,
    };
  },

  async say(playerId: string, raw: string) {
    const m = await this.memberOf(playerId);
    if (!m) throw new AppError(404, 'not_in_team');
    const text = cleanMessage(raw);
    if (!text) throw new AppError(400, 'empty_message');
    const p = await profileOf(playerId);
    const now = Timestamp.now();
    const teamRef = col.teams().doc(m.teamId);
    await chatGuard(playerId, text);
    await teamRef.collection('messages').add({ kind: 'text', playerId, name: p.name, avatar: p.avatar, frame: p.frame, text, helpers: [], createdAt: now });
    void teamRef.update({ activeAt: now }).catch(() => undefined);
    return { text };
  },

  async askLife(playerId: string) {
    const m = await this.memberOf(playerId);
    if (!m) throw new AppError(404, 'not_in_team');
    const p = await profileOf(playerId);
    const meRef = col.players().doc(playerId);
    const now = Timestamp.now();
    await col.players().firestore.runTransaction(async (tx) => {
      const me = await tx.get(meRef);
      const askAt = (me.get('askLifeAt') as FirebaseFirestore.Timestamp | undefined)?.toMillis() ?? 0;
      if (askAt + ASK_LIFE_COOLDOWN_MS > now.toMillis()) throw new AppError(429, 'ask_life_cooldown', undefined, { inMs: askAt + ASK_LIFE_COOLDOWN_MS - now.toMillis() });
      tx.update(meRef, { askLifeAt: now });
      tx.create(col.teams().doc(m.teamId).collection('messages').doc(), { kind: 'life', playerId, name: p.name, avatar: p.avatar, frame: p.frame, text: '', helpers: [], createdAt: now });
    });
  },

  async askCoins(playerId: string) {
    const m = await this.memberOf(playerId);
    if (!m) throw new AppError(404, 'not_in_team');
    const p = await profileOf(playerId);
    const meRef = col.players().doc(playerId);
    const now = Timestamp.now();
    await col.players().firestore.runTransaction(async (tx) => {
      const me = await tx.get(meRef);
      const askAt = (me.get('askCoinsAt') as FirebaseFirestore.Timestamp | undefined)?.toMillis() ?? 0;
      if (askAt + ASK_COINS_COOLDOWN_MS > now.toMillis()) throw new AppError(429, 'ask_coins_cooldown', undefined, { inMs: askAt + ASK_COINS_COOLDOWN_MS - now.toMillis() });
      tx.update(meRef, { askCoinsAt: now });
      tx.create(col.teams().doc(m.teamId).collection('messages').doc(), { kind: 'coins', playerId, name: p.name, avatar: p.avatar, frame: p.frame, text: '', helpers: [], createdAt: now });
    });
  },

  /** Answering a teammate's life (or coins) card: daily help cap + asker must still be in the team. */
  async help(playerId: string, messageId: string) {
    const m = await this.memberOf(playerId);
    if (!m) throw new AppError(404, 'not_in_team');
    const msgRef = col.teams().doc(m.teamId).collection('messages').doc(messageId);
    const mePlayerRef = col.players().doc(playerId);
    const today = todayUtc();
    let sent: { asker: string; kind: string } | null = null;
    await col.teams().firestore.runTransaction(async (tx) => {
      const [msg, meDoc] = await Promise.all([tx.get(msgRef), tx.get(mePlayerRef)]);
      const kind = msg.exists ? (msg.get('kind') as string) : '';
      if (kind !== 'life' && kind !== 'coins') throw new AppError(404, 'message_not_found');
      const asker = msg.get('playerId') as string;
      const helpers = (msg.get('helpers') as string[]) ?? [];
      if (asker === playerId) throw new AppError(400, 'own_request');
      if (helpers.includes(playerId)) throw new AppError(409, 'already_helped');
      if (helpers.length >= (kind === 'coins' ? COIN_HELPS : LIFE_HELPS)) throw new AppError(409, 'request_full');
      if (dailyQuotaExceeded(meDoc.get('helpDay'), meDoc.get('helpN'), today, MAX_HELPS_PER_DAY)) {
        throw new AppError(429, 'help_limit_today');
      }
      // Asker must still belong to this team (prevents farming old cards after leaving).
      const askerMember = await tx.get(col.teamMembers().doc(asker));
      if (!askerMember.exists || askerMember.get('teamId') !== m.teamId) throw new AppError(404, 'message_not_found');
      const sameDay = meDoc.get('helpDay') === today;
      tx.set(mePlayerRef, { helpDay: today, helpN: sameDay ? ((meDoc.get('helpN') as number) ?? 0) + 1 : 1 }, { merge: true });
      tx.update(msgRef, { helpers: FieldValue.arrayUnion(playerId) });
      const gift = kind === 'coins' ? { coins: FieldValue.increment(COIN_GIFT) } : { lives: FieldValue.increment(1) };
      tx.set(col.lifeInbox().doc(asker), { ...gift, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.update(col.teamMembers().doc(playerId), { helps: FieldValue.increment(1) });
      sent = { asker, kind };
    });
    // The asker's phone: who sent them what (even while the game is closed).
    if (sent) {
      const s = sent as { asker: string; kind: string };
      const helper = await profileOf(playerId).catch(() => null);
      const who = helper?.name ?? 'A teammate';
      void pushService
        .toPlayer(s.asker, s.kind === 'coins' ? 'Coins received! 🪙' : 'A life for you! ❤️', s.kind === 'coins' ? `${who} sent you coins!` : `${who} sent you a life!`, { kind: 'team_help' })
        .catch(() => undefined);
    }
    return { coins: HELP_COINS };
  },

  /**
   * The lives teammates sent, taken; the game adds them. `max`: only as many as the player has room
   * for (their hearts are capped): the rest stay in the inbox for later, never lost. No `max`: all.
   */
  async takeLives(playerId: string, max?: number): Promise<number> {
    const ref = col.lifeInbox().doc(playerId);
    return col.lifeInbox().firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const have = (snap.get('lives') as number) ?? 0;
      const n = max === undefined ? have : Math.max(0, Math.min(have, Math.floor(max)));
      if (n > 0) tx.set(ref, { lives: have - n, takenAt: FieldValue.serverTimestamp() }, { merge: true });
      return n;
    });
  },

  /** The coins teammates sent, taken (that part of the inbox emptied); the game adds them. */
  async takeCoins(playerId: string): Promise<number> {
    const ref = col.lifeInbox().doc(playerId);
    return col.lifeInbox().firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const n = (snap.get('coins') as number) ?? 0;
      if (n > 0) tx.set(ref, { coins: 0, coinsTakenAt: FieldValue.serverTimestamp() }, { merge: true });
      return n;
    });
  },

  async report(playerId: string, messageId: string, reason: string) {
    const m = await this.memberOf(playerId);
    if (!m) throw new AppError(404, 'not_in_team');
    const msg = await col.teams().doc(m.teamId).collection('messages').doc(messageId).get();
    if (!msg.exists) throw new AppError(404, 'message_not_found');
    await col.reports().add({
      reporter: playerId,
      teamId: m.teamId,
      messageId,
      reported: msg.get('playerId'),
      text: msg.get('text'),
      reason: String(reason || 'other').slice(0, 40),
      createdAt: FieldValue.serverTimestamp(),
    });
  },

  /** A non-hidden member's level rose: the team's score and the member's row follow atomically. */
  async onLevel(playerId: string, level: number) {
    const ref = col.teamMembers().doc(playerId);
    await col.teamMembers().firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const m = snap.data() as MemberDoc;
      const prevCounted = m.countedScore ?? m.level ?? 0;
      const delta = level - prevCounted;
      if (delta <= 0 && level <= (m.level ?? 0)) return;
      const teamRef = col.teams().doc(m.teamId);
      const teamSnap = await tx.get(teamRef);
      tx.update(ref, { level: Math.max(level, m.level ?? 0), countedScore: Math.max(level, prevCounted) });
      if (teamSnap.exists && delta > 0) {
        tx.update(teamRef, { score: FieldValue.increment(delta), activeAt: Timestamp.now() });
      }
    });
  },

  /** Called when a player transitions to shadowbanned: subtracts their contribution from their team's score. */
  async onHidden(playerId: string): Promise<void> {
    const ref = col.teamMembers().doc(playerId);
    const changed = await col.teamMembers().firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const m = snap.data() as MemberDoc;
      const sub = Math.max(0, m.countedScore ?? m.level ?? 0);
      if (sub === 0 && m.countedScore === 0) return false;
      const teamRef = col.teams().doc(m.teamId);
      const teamSnap = await tx.get(teamRef);
      tx.update(ref, { countedScore: 0 });
      if (teamSnap.exists && sub > 0) {
        const cur = (teamSnap.get('score') as number) ?? 0;
        tx.update(teamRef, { score: Math.max(0, cur - sub) });
      }
      return true;
    });
    if (changed) listCache.clear();
  },

  /** Called when a hidden player is shown again (admin unhide): their level counts for the team again. */
  async onUnhidden(playerId: string): Promise<void> {
    const ref = col.teamMembers().doc(playerId);
    const changed = await col.teamMembers().firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const m = snap.data() as MemberDoc;
      const level = Math.max(0, m.level ?? 0);
      const counted = m.countedScore ?? level;
      const add = level - counted;
      if (add <= 0) return false;
      const teamRef = col.teams().doc(m.teamId);
      const teamSnap = await tx.get(teamRef);
      tx.update(ref, { countedScore: level });
      if (teamSnap.exists) tx.update(teamRef, { score: FieldValue.increment(add) });
      return true;
    });
    if (changed) listCache.clear();
  },

  /**
   * One-off repair (admin): every team's score recounted from its members, a hidden member
   * (leaderboard row `hidden`) counting 0, and each member's countedScore written to match.
   * Fixes teams whose hidden members were counted before countedScore existed.
   */
  async recountScores(): Promise<{ teams: number; teamsChanged: number; membersChanged: number; seedOpened: number }> {
    let teams = 0;
    let seedOpened = 0;
    let teamsChanged = 0;
    let membersChanged = 0;
    let last: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    for (;;) {
      let q = col.teams().orderBy('__name__').limit(100);
      if (last) q = q.startAfter(last);
      const page = await q.get();
      if (page.empty) break;
      for (const teamDoc of page.docs) {
        teams++;
        const members = await col.teamMembers().where('teamId', '==', teamDoc.id).limit(MAX_MEMBERS).get();
        const boards = members.empty ? [] : await db.getAll(...members.docs.map((d) => col.leaderboard().doc(d.id)));
        const hiddenIds = new Set(boards.filter((b) => b.exists && b.get('hidden')).map((b) => b.id));
        const batch = db.batch();
        let writes = 0;
        let score = 0;
        for (const d of members.docs) {
          const m = d.data() as MemberDoc;
          const counted = hiddenIds.has(d.id) ? 0 : Math.max(0, m.level ?? 0);
          score += counted;
          if (m.countedScore !== counted) {
            batch.update(d.ref, { countedScore: counted });
            writes++;
            membersChanged++;
          }
        }
        const t = teamDoc.data() as TeamDoc;
        const teamUpdate: Record<string, unknown> = {};
        if (t.score !== score) teamUpdate.score = score;
        if (members.size > 0 && t.members !== members.size) teamUpdate.members = members.size;
        // Sample teams (seedService, ids seed_…) stay, always open: no real leader answers requests.
        if (teamDoc.id.startsWith('seed_') && t.type !== 'open') {
          teamUpdate.type = 'open';
          seedOpened++;
        }
        if (Object.keys(teamUpdate).length > 0) {
          batch.update(teamDoc.ref, teamUpdate);
          writes++;
          teamsChanged++;
        }
        if (writes > 0) await batch.commit();
        // A sample team's waiting join requests (from when it was "by request") would never be
        // answered: they go, the cards say cancelled, the askers are free to apply elsewhere.
        if (teamDoc.id.startsWith('seed_')) await cancelAllRequests(teamDoc.id);
      }
      last = page.docs[page.docs.length - 1];
      if (page.size < 100) break;
    }
    listCache.clear();
    return { teams, teamsChanged, membersChanged, seedOpened };
  },

  /** Called after a player's first leaderboard row is created: attaches their current team name if in one. */
  async syncBoardTeam(playerId: string): Promise<void> {
    const m = await this.memberOf(playerId);
    if (!m) return;
    const team = await col.teams().doc(m.teamId).get();
    if (!team.exists) return;
    const name = team.get('name') as string | undefined;
    if (name) await col.leaderboard().doc(playerId).update({ team: name }).catch(() => undefined);
  },
};
