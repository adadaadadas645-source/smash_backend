import { createSign } from 'crypto';
import { connect, ClientHttp2Session } from 'http2';
import { config } from '../config';
import { col, FieldValue } from '../firebase';
import { getMessaging } from 'firebase-admin/messaging';
import { logger } from '../utils/logger';

/**
 * Pushes to a player's phone while the game is closed (Apple's APNs, token auth with the .p8
 * key). Each player keeps one iPhone token: players/{id}.push = { token, env: sandbox | production }.
 * A token Apple says is gone (410, BadDeviceToken) is taken away. Off while APNS_KEY is not set.
 */
let jwt: { token: string; at: number } | null = null;
const sessions = new Map<string, ClientHttp2Session>();

function bearer(): string | null {
  const a = config.apns;
  if (!a) return null;
  // A token lasts an hour at Apple; a new one every 50 minutes.
  if (jwt && Date.now() - jwt.at < 50 * 60_000) return jwt.token;
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'ES256', kid: a.keyId });
  const body = b64({ iss: a.teamId, iat: Math.floor(Date.now() / 1000) });
  const sig = createSign('sha256').update(`${head}.${body}`).sign({ key: a.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  jwt = { token: `${head}.${body}.${sig}`, at: Date.now() };
  return jwt.token;
}

function session(host: string): ClientHttp2Session {
  const old = sessions.get(host);
  if (old && !old.closed && !old.destroyed) return old;
  const s = connect(`https://${host}`);
  s.on('error', () => sessions.delete(host));
  s.on('close', () => sessions.delete(host));
  sessions.set(host, s);
  return s;
}

function send(token: string, env: string, payload: object): Promise<number> {
  const auth = bearer();
  if (!auth) return Promise.resolve(0);
  const host = env === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
  return new Promise((resolve) => {
    try {
      const req = session(host).request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        authorization: `bearer ${auth}`,
        'apns-topic': config.apns!.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      });
      let status = 0;
      let data = '';
      req.setTimeout(10_000, () => { req.close(); resolve(0); });
      req.on('response', (h) => { status = Number(h[':status'] ?? 0); });
      req.on('data', (c) => { data += c; });
      req.on('end', () => {
        if (status !== 200) logger.warn({ status, data }, 'push: not sent');
        resolve(status);
      });
      req.on('error', () => resolve(0));
      req.end(JSON.stringify(payload));
    } catch {
      resolve(0);
    }
  });
}

export const pushService = {
  get enabled() {
    return !!config.apns;
  },

  async saveToken(playerId: string, token: string, env: 'sandbox' | 'production' | 'fcm') {
    await col.players().doc(playerId).set({ push: { token, env } }, { merge: true });
  },

  /**
   * A short alert to one player (nothing when they have no token). Team chat sends none: the only
   * team alert is a teammate's gift (team_help: a life or coins received), sent whatever the
   * player's chat switch, since it is not chat.
   */
  async toPlayer(playerId: string, title: string, body: string, data: Record<string, string> = {}) {
    const p = await col.players().doc(playerId).get();
    const push = p.get('push') as { token?: string; env?: string } | undefined;
    if (!push?.token) return;
    if (push.env !== 'fcm' && !config.apns) return;
    // Android: Firebase Cloud Messaging (the backend's own Firebase project; no key of its own).
    if (push.env === 'fcm') {
      try {
        await getMessaging().send({ token: push.token, notification: { title, body }, data, android: { priority: 'high', notification: { channelId: 'ks_reminders', sound: 'default' } } });
      } catch (err) {
        const code = (err as { code?: string }).code ?? '';
        logger.warn({ code }, 'push: fcm not sent');
        if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token') || code.includes('invalid-argument'))
          await col.players().doc(playerId).update({ push: FieldValue.delete() }).catch(() => undefined);
      }
      return;
    }
    const status = await send(push.token, push.env ?? 'production', { aps: { alert: { title, body }, sound: 'default' }, ...data });
    if (status === 410 || status === 400) await col.players().doc(playerId).update({ push: FieldValue.delete() }).catch(() => undefined);
  },
};
