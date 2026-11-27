import { z } from 'zod';
import { col, FieldValue, Timestamp } from '../firebase';
import { AppError } from '../middleware/errorHandler';
import { TtlCache } from '../utils/ttlCache';
import { cleanMessage, hidePersonal, isRude, nameIsRude } from './chatFilter';
import { cleanName, Stats } from './profile';
import { playerService } from './playerService';
import { safetyService } from './safetyService';
import { pushService } from './pushService';

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
 * kingdom_teams/{teamId}/requests/{pid}  a "by request" team's waiting asker: messageId, level, name, at (the
 *                                        chat card `joinRequest`, the leader's alone, who accepts or declines)
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
/** The level a player must reach to make a team (joining one has no such bar, only the team's own). */
export const CREATE_FROM_LEVEL = 80;
export const LIFE_HELPS = 5;
export const HELP_COINS = 5;
export const ASK_LIFE_COOLDOWN_MS = 4 * 60 * 60 * 1000;
/**
 * Asking for coins: once every ASK_COINS_COOLDOWN_MS, a "coins" card that up to COIN_HELPS
 * teammates answer; each answer puts COIN_GIFT coins in the asker's inbox (the game adds them)
 * and gives the helper HELP_COINS, as a life does.
 */
export const COIN_HELPS = 5;
export const COIN_GIFT = 20;
export const ASK_COINS_COOLDOWN_MS = 8 * 60 * 60 * 1000;
export const CREST_COUNT = 48;
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
  /** The founder's country ("TR"), for the country's team board; null when not known. */
  country?: string | null;
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
  kind: 'text' | 'life' | 'coins' | 'join' | 'leave' | 'joinRequest';
  /** A join request's state: pending, accepted or declined. */
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
    country: t.country ?? null,
    // Activity from the last message or member change: high within a day, medium within a week.
    activity: activeHours < 24 ? 'high' : activeHours < 24 * 7 ? 'medium' : 'low',
  };
}

const ROLE_ORDER: Record<Role, number> = { leader: 0, coleader: 1, knight: 2 };

const listCache = new TtlCache<ReturnType<typeof teamOut>[]>(30_000, 60);

/** The team's name on the player's leaderboard row (the boards show it under the player's name). */
function boardTeam(tx: FirebaseFirestore.Transaction, playerId: string, name: string | null) {
  tx.set(col.leaderboard().doc(playerId), { team: name ?? FieldValue.delete() }, { merge: true });
}

async function profileOf(playerId: string) {
  const p = await playerService.get(playerId);
  if (!p) throw new AppError(404, 'player_not_found');
  if (p.banned) throw new AppError(403, 'banned');
  return { name: p.name, avatar: p.avatar, frame: p.frame, level: p.level ?? 1 };
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
      // One country: no composite index, sorted here.
      const snap = await col.teams().where('country', '==', cc).limit(1000).get();
      return snap.docs
        .map((d) => teamOut(d.id, d.data() as TeamDoc))
        .sort((a, b) => b.score - a.score)
        .slice(0, 100);
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
    // Their profile's numbers (the leaderboard rows), for their card.
    const board = members.empty ? [] : await col.leaderboard().firestore.getAll(...members.docs.map((d) => col.leaderboard().doc(d.id)));
    const statsOf = new Map(board.filter((b) => b.exists && b.get('stats')).map((b) => [b.id, b.get('stats') as Stats]));
    const rows = members.docs
      .map((d) => {
        const m = d.data() as MemberDoc;
        // A sample team's member (seedService) has no board row: their numbers are on the member.
        const stats = statsOf.get(d.id) ?? ((m as MemberDoc & { stats?: Stats }).stats);
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
    const country = ((await col.leaderboard().doc(playerId).get()).get('country') as string | undefined) ?? null;
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
        country,
        createdAt: now,
        activeAt: now,
      } satisfies TeamDoc);
      boardTeam(tx, playerId, name);
      tx.create(col.teamMembers().doc(playerId), { teamId: teamRef.id, role: 'leader', level: me.level, helps: 0, name: me.name, avatar: me.avatar, frame: me.frame, joinedAt: now } satisfies MemberDoc);
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
      const [team, mine, waiting] = await Promise.all([tx.get(teamRef), tx.get(col.teamMembers().doc(playerId)), tx.get(reqRef)]);
      if (!team.exists) throw new AppError(404, 'team_not_found');
      if (mine.exists) throw new AppError(409, 'already_in_team');
      const t = team.data() as TeamDoc;
      if (t.members >= MAX_MEMBERS) throw new AppError(409, 'team_full');
      if (me.level < t.minLevel) throw new AppError(403, 'level_too_low');
      if (t.type === 'request') {
        // Asked already: it waits as it is.
        if (waiting.exists) return true;
        // One request at a time: another team's still waiting -> no.
        const meDoc = await tx.get(col.players().doc(playerId));
        const pending = meDoc.get('pendingTeam') as { teamId: string } | undefined;
        if (pending && pending.teamId !== teamId) {
          const other = await tx.get(col.teams().doc(pending.teamId).collection('requests').doc(playerId));
          if (other.exists) throw new AppError(409, 'request_pending', undefined, { team: (meDoc.get('pendingTeam') as { name?: string }).name ?? null });
        }
        tx.set(col.players().doc(playerId), { pendingTeam: { teamId, name: t.name, at: now } }, { merge: true });
        const msgRef = teamRef.collection('messages').doc();
        tx.create(msgRef, { kind: 'joinRequest', playerId, name: me.name, avatar: me.avatar, frame: me.frame, text: `Level ${me.level}`, status: 'pending', helpers: [], createdAt: now });
        tx.create(reqRef, { messageId: msgRef.id, level: me.level, name: me.name, avatar: me.avatar, frame: me.frame, at: now });
        return true;
      }
      tx.update(teamRef, { members: FieldValue.increment(1), score: FieldValue.increment(me.level), activeAt: now });
      boardTeam(tx, playerId, t.name);
      tx.create(col.teamMembers().doc(playerId), { teamId, role: 'knight', level: me.level, helps: 0, name: me.name, avatar: me.avatar, frame: me.frame, joinedAt: now } satisfies MemberDoc);
      tx.create(teamRef.collection('messages').doc(), { kind: 'join', playerId, name: me.name, avatar: me.avatar, frame: me.frame, text: '', helpers: [], createdAt: now });
      tx.set(col.players().doc(playerId), { pendingTeam: FieldValue.delete() }, { merge: true });
      return false;
    });
    if (!requested) listCache.clear();
    return { requested };
  },

  /** The leader answers a join request to their team: in (if there is room), or not. */
  async answerRequest(byId: string, askerId: string, accept: boolean): Promise<{ joined: boolean }> {
    const by = await this.memberOf(byId);
    if (!by) throw new AppError(404, 'not_in_team');
    // Only the team's leader (the one who made it, or who took the lead after them).
    if (by.role !== 'leader') throw new AppError(403, 'not_team_leader');
    const teamRef = col.teams().doc(by.teamId);
    const reqRef = teamRef.collection('requests').doc(askerId);
    const asker = accept ? await profileOf(askerId) : null;
    const now = Timestamp.now();
    const joined = await col.teams().firestore.runTransaction(async (tx) => {
      const [req, team, theirs] = await Promise.all([tx.get(reqRef), tx.get(teamRef), tx.get(col.teamMembers().doc(askerId))]);
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
      if (theirs.exists) { tx.set(msgRef, { status: 'taken' }, { merge: true }); tx.set(col.players().doc(askerId), { pendingTeam: FieldValue.delete() }, { merge: true }); return false; }
      if (t.members >= MAX_MEMBERS) throw new AppError(409, 'team_full');
      tx.set(msgRef, { status: 'accepted' }, { merge: true });
      answer(true);
      tx.update(teamRef, { members: FieldValue.increment(1), score: FieldValue.increment(asker!.level), activeAt: now });
      boardTeam(tx, askerId, t.name);
      tx.create(col.teamMembers().doc(askerId), { teamId: by.teamId, role: 'knight', level: asker!.level, helps: 0, name: asker!.name, avatar: asker!.avatar, frame: asker!.frame, joinedAt: now } satisfies MemberDoc);
      tx.create(teamRef.collection('messages').doc(), { kind: 'join', playerId: askerId, name: asker!.name, avatar: asker!.avatar, frame: asker!.frame, text: '', helpers: [], createdAt: now });
      return true;
    });
    if (joined) listCache.clear();
    return { joined };
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
      boardTeam(tx, playerId, null);
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
    // A join request's card is the leader's alone (they answer it); the others see the "joined" line after.
    const [blocked, meDoc] = await Promise.all([safetyService.blocked(playerId), col.players().doc(playerId).get()]);
    const chatOff = !!meDoc.get('chatOff');
    const rows: MessageOut[] = snap.docs
      .filter((d) => d.get('kind') !== 'joinRequest' || m.role === 'leader')
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
    const me = await col.players().doc(playerId).get();
    const askAt = (me.get('askLifeAt') as FirebaseFirestore.Timestamp | undefined)?.toMillis() ?? 0;
    const coinsAt = (me.get('askCoinsAt') as FirebaseFirestore.Timestamp | undefined)?.toMillis() ?? 0;
    const inbox = await col.lifeInbox().doc(playerId).get();
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

  /** Answering a teammate's life (or coins) card: a life (or COIN_GIFT coins) into their inbox, the helper's help counted. */
  async help(playerId: string, messageId: string) {
    const m = await this.memberOf(playerId);
    if (!m) throw new AppError(404, 'not_in_team');
    const msgRef = col.teams().doc(m.teamId).collection('messages').doc(messageId);
    let sent: { asker: string; kind: string } | null = null;
    await col.teams().firestore.runTransaction(async (tx) => {
      const msg = await tx.get(msgRef);
      const kind = msg.exists ? (msg.get('kind') as string) : '';
      if (kind !== 'life' && kind !== 'coins') throw new AppError(404, 'message_not_found');
      const asker = msg.get('playerId') as string;
      const helpers = (msg.get('helpers') as string[]) ?? [];
      if (asker === playerId) throw new AppError(400, 'own_request');
      if (helpers.includes(playerId)) throw new AppError(409, 'already_helped');
      if (helpers.length >= (kind === 'coins' ? COIN_HELPS : LIFE_HELPS)) throw new AppError(409, 'request_full');
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

  /** A member's level rose: the team's score and the member's row follow. */
  async onLevel(playerId: string, level: number) {
    const ref = col.teamMembers().doc(playerId);
    const snap = await ref.get();
    if (!snap.exists) return;
    const m = snap.data() as MemberDoc;
    const delta = level - (m.level ?? 0);
    if (delta <= 0) return;
    // A member playing keeps the team active (its Activity: high within a day of a level won).
    await Promise.all([ref.update({ level }), col.teams().doc(m.teamId).update({ score: FieldValue.increment(delta), activeAt: Timestamp.now() })]);
  },
};
