import { z } from 'zod';
import { col, FieldValue, Timestamp } from '../firebase';
import { AppError } from '../middleware/errorHandler';
import { TtlCache } from '../utils/ttlCache';
import { cleanMessage } from './chatFilter';
import { cleanName } from './profile';
import { playerService } from './playerService';

/**
 * Teams: a name, a crest, a short description, who may join (open, or by request: the leader
 * lets them in), the level and crowns a member needs, at most MAX_MEMBERS. Each player is in one
 * team at most. The team's score is its members' levels added up, kept on the team as they
 * change (join, leave, a member's level rising).
 *
 * kingdom_teams/{teamId}                 name, nameLower, description, crest, type, minLevel,
 *                                        minCrowns, members, score, leaderId, createdAt, activeAt
 * kingdom_teams/{teamId}/messages/{id}   kind (text | life | join | leave), playerId, name, avatar,
 *                                        frame, text, helpers[], createdAt
 * kingdom_team_members/{playerId}        teamId, role (leader | coleader | knight), level, helps,
 *                                        name, avatar, frame, joinedAt
 * kingdom_life_inbox/{playerId}          lives (sent by teammates, not taken yet), from[]
 *
 * Asking for a life: once every ASK_LIFE_COOLDOWN_MS, a "life" card in the chat that up to
 * LIFE_HELPS teammates can answer, each once; each answer puts a life in the asker's inbox and
 * gives the helper HELP_COINS coins (the game adds them; the server counts the help).
 */
export const MAX_MEMBERS = 50;
export const CREATE_COST = 100;
export const LIFE_HELPS = 5;
export const HELP_COINS = 5;
export const ASK_LIFE_COOLDOWN_MS = 4 * 60 * 60 * 1000;
export const CREST_COUNT = 20;
const MESSAGES_KEPT = 60;

export const createSchema = z.object({
  name: z.string().min(1).max(40),
  description: z.string().max(160).optional().default(''),
  crest: z.number().int().min(0).max(CREST_COUNT - 1),
  type: z.enum(['open', 'request']).default('open'),
  minLevel: z.number().int().min(0).max(100000).default(0),
  minCrowns: z.number().int().min(0).max(1000000).default(0),
});

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
  createdAt: FirebaseFirestore.Timestamp;
  activeAt: FirebaseFirestore.Timestamp;
}

export interface MemberDoc {
  teamId: string;
  role: Role;
  level: number;
  helps: number;
  name: string;
  avatar: string;
  frame: string;
  joinedAt: FirebaseFirestore.Timestamp;
}

export interface MessageOut {
  id: string;
  kind: 'text' | 'life' | 'join' | 'leave';
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
    score: t.score,
    // Activity from the last message or member change: high within a day, medium within a week.
    activity: activeHours < 24 ? 'high' : activeHours < 24 * 7 ? 'medium' : 'low',
  };
}

const ROLE_ORDER: Record<Role, number> = { leader: 0, coleader: 1, knight: 2 };

const listCache = new TtlCache<ReturnType<typeof teamOut>[]>(30_000, 8);

async function profileOf(playerId: string) {
  const p = await playerService.get(playerId);
  if (!p) throw new AppError(404, 'player_not_found');
  if (p.banned) throw new AppError(403, 'banned');
  return { name: p.name, avatar: p.avatar, frame: p.frame, level: p.level ?? 1 };
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

  /** The team board, the highest score first. */
  async top(): Promise<ReturnType<typeof teamOut>[]> {
    return listCache.getOrLoad('top', async () => {
      const snap = await col.teams().orderBy('score', 'desc').limit(100).get();
      return snap.docs.map((d) => teamOut(d.id, d.data() as TeamDoc));
    });
  },

  /** Teams whose name starts with the text (case-insensitive). */
  async search(q: string): Promise<ReturnType<typeof teamOut>[]> {
    const key = cleanName(q).toLocaleLowerCase('tr');
    if (key.length < 2) return [];
    const snap = await col.teams().where('nameLower', '>=', key).where('nameLower', '<', key + '').limit(20).get();
    return snap.docs.map((d) => teamOut(d.id, d.data() as TeamDoc));
  },

  /** A team and its members (the info page). */
  async info(teamId: string) {
    const snap = await col.teams().doc(teamId).get();
    if (!snap.exists) throw new AppError(404, 'team_not_found');
    const members = await col.teamMembers().where('teamId', '==', teamId).limit(MAX_MEMBERS).get();
    const rows = members.docs
      .map((d) => {
        const m = d.data() as MemberDoc;
        return { playerId: d.id, name: m.name, avatar: m.avatar, frame: m.frame, role: m.role, level: m.level, helps: m.helps ?? 0 };
      })
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || b.level - a.level);
    return { team: teamOut(snap.id, snap.data() as TeamDoc), members: rows };
  },

  async create(playerId: string, input: z.infer<typeof createSchema>) {
    const me = await profileOf(playerId);
    const name = cleanName(input.name);
    const nameLower = name.toLocaleLowerCase('tr');
    const taken = await col.teams().where('nameLower', '==', nameLower).limit(1).get();
    if (!taken.empty) throw new AppError(409, 'team_name_taken');
    const teamRef = col.teams().doc();
    const now = Timestamp.now();
    await col.teams().firestore.runTransaction(async (tx) => {
      const mine = await tx.get(col.teamMembers().doc(playerId));
      if (mine.exists) throw new AppError(409, 'already_in_team');
      tx.create(teamRef, {
        name,
        nameLower,
        description: cleanMessage(input.description ?? '').slice(0, 160),
        crest: input.crest,
        type: input.type,
        minLevel: input.minLevel,
        minCrowns: input.minCrowns,
        members: 1,
        score: me.level,
        leaderId: playerId,
        createdAt: now,
        activeAt: now,
      } satisfies TeamDoc);
      tx.create(col.teamMembers().doc(playerId), { teamId: teamRef.id, role: 'leader', level: me.level, helps: 0, name: me.name, avatar: me.avatar, frame: me.frame, joinedAt: now } satisfies MemberDoc);
    });
    listCache.clear();
    return { id: teamRef.id };
  },

  async join(playerId: string, teamId: string) {
    const me = await profileOf(playerId);
    const teamRef = col.teams().doc(teamId);
    const now = Timestamp.now();
    await col.teams().firestore.runTransaction(async (tx) => {
      const [team, mine] = await Promise.all([tx.get(teamRef), tx.get(col.teamMembers().doc(playerId))]);
      if (!team.exists) throw new AppError(404, 'team_not_found');
      if (mine.exists) throw new AppError(409, 'already_in_team');
      const t = team.data() as TeamDoc;
      if (t.members >= MAX_MEMBERS) throw new AppError(409, 'team_full');
      if (me.level < t.minLevel) throw new AppError(403, 'level_too_low');
      // "By request" teams: the request waits for the leader (a later version); for now they are joined as open ones.
      tx.update(teamRef, { members: FieldValue.increment(1), score: FieldValue.increment(me.level), activeAt: now });
      tx.create(col.teamMembers().doc(playerId), { teamId, role: 'knight', level: me.level, helps: 0, name: me.name, avatar: me.avatar, frame: me.frame, joinedAt: now } satisfies MemberDoc);
      tx.create(teamRef.collection('messages').doc(), { kind: 'join', playerId, name: me.name, avatar: me.avatar, frame: me.frame, text: '', helpers: [], createdAt: now });
    });
    listCache.clear();
  },

  /** Leaving: the last member out closes the team; a leader leaving hands the lead to the highest member. */
  async leave(playerId: string) {
    const memberRef = col.teamMembers().doc(playerId);
    const mine = await memberRef.get();
    if (!mine.exists) throw new AppError(404, 'not_in_team');
    const m = mine.data() as MemberDoc;
    const teamRef = col.teams().doc(m.teamId);
    let heir: string | null = null;
    if (m.role === 'leader') {
      const others = await col.teamMembers().where('teamId', '==', m.teamId).limit(MAX_MEMBERS).get();
      const next = others.docs
        .filter((d) => d.id !== playerId)
        .map((d) => ({ id: d.id, m: d.data() as MemberDoc }))
        .sort((a, b) => ROLE_ORDER[a.m.role] - ROLE_ORDER[b.m.role] || b.m.level - a.m.level)[0];
      heir = next?.id ?? null;
    }
    const now = Timestamp.now();
    await col.teams().firestore.runTransaction(async (tx) => {
      const team = await tx.get(teamRef);
      tx.delete(memberRef);
      if (!team.exists) return;
      const t = team.data() as TeamDoc;
      if (t.members <= 1) {
        tx.delete(teamRef);
        return;
      }
      const update: Record<string, unknown> = { members: FieldValue.increment(-1), score: FieldValue.increment(-(m.level ?? 0)), activeAt: now };
      if (heir) {
        update.leaderId = heir;
        tx.update(col.teamMembers().doc(heir), { role: 'leader' });
      }
      tx.update(teamRef, update);
      tx.create(teamRef.collection('messages').doc(), { kind: 'leave', playerId, name: m.name, avatar: m.avatar, frame: m.frame, text: '', helpers: [], createdAt: now });
    });
    listCache.clear();
  },

  /** The last messages of the player's team, oldest first, and whether a life may be asked for. */
  async messages(playerId: string) {
    const m = await this.memberOf(playerId);
    if (!m) throw new AppError(404, 'not_in_team');
    const snap = await col.teams().doc(m.teamId).collection('messages').orderBy('createdAt', 'desc').limit(MESSAGES_KEPT).get();
    const rows: MessageOut[] = snap.docs
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
        } satisfies MessageOut;
      })
      .reverse();
    const me = await col.players().doc(playerId).get();
    const askAt = (me.get('askLifeAt') as FirebaseFirestore.Timestamp | undefined)?.toMillis() ?? 0;
    const inbox = await col.lifeInbox().doc(playerId).get();
    return { teamId: m.teamId, role: m.role, messages: rows, askLifeInMs: Math.max(0, askAt + ASK_LIFE_COOLDOWN_MS - Date.now()), livesWaiting: (inbox.get('lives') as number) ?? 0 };
  },

  async say(playerId: string, raw: string) {
    const m = await this.memberOf(playerId);
    if (!m) throw new AppError(404, 'not_in_team');
    const text = cleanMessage(raw);
    if (!text) throw new AppError(400, 'empty_message');
    const p = await profileOf(playerId);
    const now = Timestamp.now();
    const teamRef = col.teams().doc(m.teamId);
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

  /** Answering a teammate's life card: a life into their inbox, the helper's help counted. */
  async help(playerId: string, messageId: string) {
    const m = await this.memberOf(playerId);
    if (!m) throw new AppError(404, 'not_in_team');
    const msgRef = col.teams().doc(m.teamId).collection('messages').doc(messageId);
    await col.teams().firestore.runTransaction(async (tx) => {
      const msg = await tx.get(msgRef);
      if (!msg.exists || msg.get('kind') !== 'life') throw new AppError(404, 'message_not_found');
      const asker = msg.get('playerId') as string;
      const helpers = (msg.get('helpers') as string[]) ?? [];
      if (asker === playerId) throw new AppError(400, 'own_request');
      if (helpers.includes(playerId)) throw new AppError(409, 'already_helped');
      if (helpers.length >= LIFE_HELPS) throw new AppError(409, 'request_full');
      tx.update(msgRef, { helpers: FieldValue.arrayUnion(playerId) });
      tx.set(col.lifeInbox().doc(asker), { lives: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.update(col.teamMembers().doc(playerId), { helps: FieldValue.increment(1) });
    });
    return { coins: HELP_COINS };
  },

  /** The lives teammates sent, taken (the inbox emptied); the game adds them. */
  async takeLives(playerId: string): Promise<number> {
    const ref = col.lifeInbox().doc(playerId);
    return col.lifeInbox().firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const n = (snap.get('lives') as number) ?? 0;
      if (n > 0) tx.set(ref, { lives: 0, takenAt: FieldValue.serverTimestamp() }, { merge: true });
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

  /** A member's level rose: the team's score and the member's row follow. */
  async onLevel(playerId: string, level: number) {
    const ref = col.teamMembers().doc(playerId);
    const snap = await ref.get();
    if (!snap.exists) return;
    const m = snap.data() as MemberDoc;
    const delta = level - (m.level ?? 0);
    if (delta <= 0) return;
    await Promise.all([ref.update({ level }), col.teams().doc(m.teamId).update({ score: FieldValue.increment(delta) })]);
  },
};
