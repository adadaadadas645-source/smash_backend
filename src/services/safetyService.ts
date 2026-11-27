import { col, db, FieldValue, Timestamp } from '../firebase';
import { AppError } from '../middleware/errorHandler';
import { TtlCache } from '../utils/ttlCache';

/**
 * Keeping players safe in chat: blocks (kept here, on every device the player uses), turning
 * chat off, and taking everything social away when an account is deleted.
 *
 * kingdom_blocks/{owner}__{other}   { owner, other, at }
 */
const blockCache = new TtlCache<string[]>(60_000, 2000);

/** A deleted account's waiting join request: gone, and its card in the team's chat says cancelled (not a dead Accept button). */
async function cancelRequest(teamId: string, playerId: string): Promise<void> {
  const teamRef = col.teams().doc(teamId);
  const reqRef = teamRef.collection('requests').doc(playerId);
  const req = await reqRef.get().catch(() => null);
  if (!req?.exists) return;
  const msgId = req.get('messageId') as string | undefined;
  await Promise.all([
    reqRef.delete().catch(() => undefined),
    msgId ? teamRef.collection('messages').doc(msgId).set({ status: 'cancelled' }, { merge: true }).catch(() => undefined) : Promise.resolve(),
  ]);
}

export const safetyService = {
  async blocked(playerId: string): Promise<string[]> {
    return blockCache.getOrLoad(playerId, async () => (await col.blocks().where('owner', '==', playerId).limit(500).get()).docs.map((d) => d.get('other') as string));
  },

  async setBlock(playerId: string, other: string, block: boolean) {
    if (other === playerId) throw new AppError(400, 'own_id');
    const ref = col.blocks().doc(`${playerId}__${other}`);
    if (block) await ref.set({ owner: playerId, other, at: Timestamp.now() });
    else await ref.delete();
    blockCache.delete(playerId);
    return { blocked: block };
  },

  /** Whether `owner` blocked `other`. */
  async blocks(owner: string, other: string): Promise<boolean> {
    return (await this.blocked(owner)).includes(other);
  },

  async setChatOff(playerId: string, off: boolean) {
    await col.players().doc(playerId).update({ chatOff: off });
    return { chatOff: off };
  },

  /**
   * An account deleted: its friendships (both sides), direct message threads, blocks (both
   * ways), the reports it made, weekly race rows, tournament entries, any pending team join
   * request, and its words in its team's chat. The team itself is left by the caller
   * (teamService.leave), so the count and the lead stay right.
   */
  async forget(playerId: string, teamId: string | null) {
    const prefix = col.players().id.replace(/players$/, '');
    const pSnap = await col.players().doc(playerId).get().catch(() => null);
    const pendingTeamId = (pSnap?.get('pendingTeam') as { teamId?: string } | undefined)?.teamId ?? null;
    const queries = [
      col.friends().where('owner', '==', playerId),
      col.friends().where('other', '==', playerId),
      col.blocks().where('owner', '==', playerId),
      col.blocks().where('other', '==', playerId),
      col.reports().where('reporter', '==', playerId),
      col.weekly().where('playerId', '==', playerId),
      db.collection(`${prefix}tournament_entries`).where('playerId', '==', playerId),
      db.collection(`${prefix}dm_threads`).where('a', '==', playerId),
      db.collection(`${prefix}dm_threads`).where('b', '==', playerId),
      ...(teamId ? [col.teams().doc(teamId).collection('messages').where('playerId', '==', playerId)] : []),
    ];
    let n = 0;
    const snaps = await Promise.all(queries.map((q) => q.limit(500).get()));
    for (const snap of snaps) {
      for (const d of snap.docs) {
        // A thread goes with its messages.
        if (d.ref.parent.id.endsWith('dm_threads')) await db.recursiveDelete(d.ref);
        else await d.ref.delete();
        n++;
      }
    }
    await Promise.all([
      col.lifeInbox().doc(playerId).delete().catch(() => undefined),
      pendingTeamId ? cancelRequest(pendingTeamId, playerId) : Promise.resolve(),
    ]);
    blockCache.delete(playerId);
    return n;
  },
};

export { FieldValue };
