/**
 * The whole API against the Firestore emulator, as the game uses it:
 *   firebase emulators:start --only firestore --project demo-kingdom   (in another terminal)
 *   npm run test:e2e
 * Starts the server on its own port with a throwaway licensing key, plays a player through
 * sign-up, levels, purchases (real, replayed, forged, moved to a new install) and support
 * lookups, then checks the log rows reached Firestore.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import path from 'node:path';

const PORT = 4977;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'admin-' + randomBytes(16).toString('hex');
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const env = {
  ...process.env,
  NODE_ENV: 'test',
  PORT: String(PORT),
  LOG_LEVEL: process.env.E2E_LOG_LEVEL || 'warn',
  FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8085',
  FIREBASE_PROJECT_ID: 'demo-kingdom',
  FIREBASE_SERVICE_ACCOUNT_KEY: '',
  JWT_SECRET: randomBytes(32).toString('hex'),
  DEVICE_SECRET_PEPPER: randomBytes(16).toString('hex'),
  ADMIN_API_KEY: ADMIN,
  GOOGLE_PLAY_LICENSE_KEY: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  COLLECTION_PREFIX: `e2e${Date.now()}_kingdom_`,
  LEADERBOARD_CACHE_SECONDS: '5',
};

let step = 0;
const ok = (name: string) => console.log(`  ✓ ${++step}. ${name}`);

async function call(method: string, p: string, body?: unknown, token?: string, extra: Record<string, string> = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-request-id': `e2e-${step}-${randomBytes(4).toString('hex')}`,
      'x-app-version': '1.0.9',
      'x-platform': 'Android',
      'x-device-model': 'E2E Phone',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as any;
  return { status: res.status, json, requestId: res.headers.get('x-request-id') };
}

function receipt(productId: string, token: string, opts: { forge?: boolean; orderId?: string } = {}) {
  const purchase = { orderId: opts.orderId ?? `GPA.${randomBytes(4).toString('hex')}`, packageName: 'com.puzzle.blockescape', productId, purchaseTime: Date.now(), purchaseState: 0, purchaseToken: token, quantity: 1, acknowledged: false };
  const json = JSON.stringify(purchase);
  let signature = sign('sha1', Buffer.from(json), privateKey).toString('base64');
  const signed = opts.forge ? json.replace(productId, 'gold_100000') : json;
  if (opts.forge) signature = signature.slice(0, -4) + 'AAAA';
  return JSON.stringify({ Store: 'GooglePlay', TransactionID: token, Payload: JSON.stringify({ json: signed, signature }) });
}

const secret = () => randomBytes(32).toString('hex');

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(BASE + '/health')).ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    ok('server up');

    const deep = await call('GET', '/health/deep');
    assert.equal(deep.status, 200, JSON.stringify(deep.json));
    ok(`firestore reachable (${deep.json.firestoreMs} ms)`);

    // ── Players ──
    const s1 = secret();
    const reg = await call('POST', '/api/v1/auth/register', { deviceSecret: s1, name: '  Mustafa‮ ', avatar: 'wizard', frame: 'blue', locale: 'tr' });
    assert.equal(reg.status, 201, JSON.stringify(reg.json));
    assert.equal(reg.json.player.name, 'Mustafa');
    const p1 = reg.json.playerId as string;
    let t1 = reg.json.token as string;
    ok(`register -> ${p1}`);

    assert.equal((await call('POST', '/api/v1/auth/register', { deviceSecret: 'short' })).status, 400);
    ok('register with a bad secret: 400');

    const again = await call('POST', '/api/v1/auth/token', { playerId: p1, deviceSecret: s1 });
    assert.equal(again.status, 200);
    t1 = again.json.token;
    assert.equal((await call('POST', '/api/v1/auth/token', { playerId: p1, deviceSecret: secret() })).status, 401);
    ok('sign in again with the secret; a wrong secret: 401');

    assert.equal((await call('GET', '/api/v1/players/me')).status, 401);
    assert.equal((await call('GET', '/api/v1/players/me', undefined, t1 + 'x')).json.error, 'invalid_token');
    ok('no token / bad token: 401');

    const me = await call('GET', '/api/v1/players/me', undefined, t1);
    assert.equal(me.json.player.avatar, 'wizard');
    const patched = await call('PATCH', '/api/v1/players/me', { name: 'Kral Mustafa', avatar: 'notanavatar' }, t1);
    assert.equal(patched.json.player.name, 'Kral Mustafa');
    assert.equal(patched.json.player.avatar, 'wizard');
    ok('profile read and changed (unknown avatar ignored)');

    // ── Leaderboard ──
    let lv = await call('POST', '/api/v1/leaderboard/level', { level: 42, name: 'Kral Mustafa', avatar: 'wizard', frame: 'blue' }, t1);
    assert.equal(lv.json.level, 42);
    assert.equal(lv.json.accepted, true);
    lv = await call('POST', '/api/v1/leaderboard/level', { level: 4000 }, t1);
    assert.equal(lv.json.clamped, true);
    assert.ok(lv.json.level < 50, `clamped to ${lv.json.level}`);
    const after = lv.json.level;
    lv = await call('POST', '/api/v1/leaderboard/level', { level: 10 }, t1);
    assert.equal(lv.json.level, after);
    ok(`level 42 taken, 4000 cut to ${after}, going down ignored`);

    const others: Array<{ token: string; level: number }> = [];
    for (const level of [300, 120, 7]) {
      const r = await call('POST', '/api/v1/auth/register', { deviceSecret: secret(), name: `Rakip${level}` });
      await call('POST', '/api/v1/leaderboard/level', { level }, r.json.token);
      others.push({ token: r.json.token, level });
    }
    const world = await call('GET', '/api/v1/leaderboard/world', undefined, t1);
    assert.equal(world.status, 200, JSON.stringify(world.json));
    assert.deepEqual(
      world.json.top.map((r: any) => r.level),
      [...world.json.top.map((r: any) => r.level)].sort((a: number, b: number) => b - a),
    );
    assert.equal(world.json.top[0].level, 300);
    assert.equal(world.json.me.rank, 3);
    assert.ok(world.json.top.find((r: any) => r.me));
    assert.ok(!('playerId' in world.json.top[0]), 'player ids are not public');
    ok(`world board: ${world.json.top.map((r: any) => `${r.rank}.${r.name}(${r.level})`).join(' ')}; me #${world.json.me.rank} of ${world.json.total}`);

    // ── Purchases ──
    const tokA = 'tokA_' + randomBytes(40).toString('hex');
    let v = await call('POST', '/api/v1/purchases/verify', { productId: 'pack_starter', receipt: receipt('pack_starter', tokA, { orderId: 'GPA.3311-0000-1111-22222' }) }, t1);
    assert.equal(v.status, 200, JSON.stringify(v.json));
    assert.equal(v.json.status, 'granted');
    assert.equal(v.json.grant, true);
    assert.equal(v.json.contents.coins, 1000);
    ok(`real purchase: granted (${v.json.verifiedBy})`);

    v = await call('POST', '/api/v1/purchases/verify', { productId: 'pack_starter', receipt: receipt('pack_starter', tokA) }, t1);
    assert.equal(v.json.status, 'already_granted');
    ok('same purchase sent again by its player: already_granted');

    const other = others[0].token;
    v = await call('POST', '/api/v1/purchases/verify', { productId: 'pack_starter', receipt: receipt('pack_starter', tokA) }, other);
    assert.equal(v.json.status, 'rejected');
    assert.equal(v.json.reason, 'already_used');
    ok('same consumable sent by another player: rejected (already_used)');

    v = await call('POST', '/api/v1/purchases/verify', { productId: 'gold_1000', receipt: receipt('gold_1000', 'tokF_' + randomBytes(40).toString('hex'), { forge: true }) }, t1);
    assert.equal(v.json.status, 'rejected');
    assert.equal(v.json.reason, 'bad_signature');
    ok('forged receipt: rejected (bad_signature)');

    const tokR = 'tokR_' + randomBytes(40).toString('hex');
    v = await call('POST', '/api/v1/purchases/verify', { productId: 'remove_ads', receipt: receipt('remove_ads', tokR) }, t1);
    assert.equal(v.json.status, 'granted');
    const fresh = await call('POST', '/api/v1/auth/register', { deviceSecret: secret() });
    v = await call('POST', '/api/v1/purchases/verify', { productId: 'remove_ads', receipt: receipt('remove_ads', tokR) }, fresh.json.token);
    assert.equal(v.json.status, 'already_granted');
    const freshMe = await call('GET', '/api/v1/players/me', undefined, fresh.json.token);
    assert.equal(freshMe.json.player.noAdsForever, true);
    ok('Remove Ads moves to a new install (noAdsForever on the new player)');

    const legend = await call('POST', '/api/v1/purchases/verify', { productId: 'pack_legend', receipt: receipt('pack_legend', 'tokL_' + randomBytes(40).toString('hex')) }, others[1].token);
    assert.equal(legend.json.status, 'granted');
    assert.equal((await call('GET', '/api/v1/players/me', undefined, others[1].token)).json.player.noAdsForever, true);
    ok('Legendary pack: no ads for good kept on the server');

    // Fakes Unity's editor store makes.
    v = await call('POST', '/api/v1/purchases/verify', { productId: 'gold_1000', receipt: JSON.stringify({ Store: 'fake', TransactionID: 'x', Payload: 'ThisIsFakeReceiptData' }) }, t1);
    assert.equal(v.status, 400);
    assert.equal(v.json.error, 'store_not_supported');
    ok('editor fake store: 400 store_not_supported');

    // ── Client logs ──
    const cl = await call('POST', '/api/v1/logs/client', { events: [{ name: 'purchase_failed', level: 'warn', at: Date.now(), data: { productId: 'gold_5000', reason: 'UserCancelled' } }] }, t1);
    assert.equal(cl.json.received, 1);
    ok('client log accepted');

    // ── Admin ──
    assert.equal((await call('GET', `/api/v1/admin/players/${p1}`, undefined, undefined, { 'x-admin-key': 'wrong' })).status, 401);
    const byOrder = await call('GET', '/api/v1/admin/purchases?orderId=GPA.3311-0000-1111-22222', undefined, undefined, { 'x-admin-key': ADMIN });
    assert.equal(byOrder.json.purchases.length, 1);
    assert.equal(byOrder.json.purchases[0].playerId, p1);
    ok('admin: purchase found by Google order number');

    // Logs are written in batches every 2 s.
    await new Promise((r) => setTimeout(r, 3500));
    const card = await call('GET', `/api/v1/admin/players/${p1}`, undefined, undefined, { 'x-admin-key': ADMIN });
    assert.equal(card.status, 200, JSON.stringify(card.json));
    assert.ok(!('deviceSecretHash' in card.json.player));
    assert.ok(card.json.purchases.length >= 2);
    const names = new Set(card.json.logs.map((l: any) => l.name));
    for (const n of ['player_registered', 'level_reached', 'purchase_granted', 'purchase_rejected', 'purchase_failed', 'POST /api/v1/purchases/verify']) assert.ok(names.has(n), `log row "${n}" missing; have ${[...names].join(', ')}`);
    const reqRow = card.json.logs.find((l: any) => l.kind === 'request' && l.path === '/api/v1/purchases/verify');
    assert.equal(reqRow.appVersion, '1.0.9');
    assert.equal(reqRow.deviceModel, 'E2E Phone');
    assert.ok(typeof reqRow.durationMs === 'number');
    assert.ok(!JSON.stringify(card.json.logs).includes(s1), 'device secret never stored in logs');
    ok(`admin: player card with ${card.json.purchases.length} purchases and ${card.json.logs.length} log rows`);

    const byReq = await call('GET', `/api/v1/admin/logs?requestId=${encodeURIComponent(reg.requestId!)}`, undefined, undefined, { 'x-admin-key': ADMIN });
    assert.ok(byReq.json.count >= 1);
    ok('admin: logs found by request id');

    const ban = await call('POST', `/api/v1/admin/players/${others[0].token ? (await call('GET', '/api/v1/players/me', undefined, others[0].token)).json.player.playerId : ''}/ban`, { banned: true, reason: 'e2e' }, undefined, { 'x-admin-key': ADMIN });
    assert.equal(ban.json.banned, true);
    assert.equal((await call('GET', '/api/v1/players/me', undefined, others[0].token)).status, 403);
    ok('ban: the player is refused and off the board');

    assert.equal((await call('GET', '/api/v1/nope')).status, 404);
    ok('unknown route: 404');

    console.log(`\nAll ${step} e2e steps passed.`);
  } finally {
    server.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('\nE2E FAILED:', err);
  process.exit(1);
});
