process.env.JWT_SECRET ??= 'test-secret-test-secret-test-secret-0123';
process.env.DEVICE_SECRET_PEPPER ??= 'test-pepper-0123456789';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'fatal';
process.env.LOG_REQUESTS_TO_DB = 'false';

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { findProduct } from '../src/services/catalog';
import { allowedLevel } from '../src/services/leaderboardService';
import { cleanName } from '../src/services/profile';
import { parseUnityReceipt, signatureValid } from '../src/services/receipt';
import { deviceSecretMatches, hashDeviceSecret, issueAccessToken, verifyAccessToken } from '../src/services/tokenService';
import { safeForLog } from '../src/utils/safeLog';
import { TtlCache } from '../src/utils/ttlCache';

test('allowedLevel: the first claim is taken (capped at the maximum)', () => {
  assert.deepEqual(allowedLevel(null, null, 240, 0, 5000), { level: 240, clamped: false, first: true });
  assert.deepEqual(allowedLevel(null, null, 99999, 0, 5000), { level: 5000, clamped: true, first: true });
});

test('allowedLevel: never goes down', () => {
  assert.equal(allowedLevel(50, 0, 10, 1000, 5000).level, 50);
});

test('allowedLevel: rises as fast as levels can be played, no faster', () => {
  const t0 = 1_000_000;
  // 3 free levels plus one per 15 s: after 60 s, 50 -> at most 57.
  assert.deepEqual(allowedLevel(50, t0, 51, t0 + 60_000, 5000), { level: 51, clamped: false, first: false });
  assert.deepEqual(allowedLevel(50, t0, 57, t0 + 60_000, 5000), { level: 57, clamped: false, first: false });
  assert.deepEqual(allowedLevel(50, t0, 900, t0 + 60_000, 5000), { level: 57, clamped: true, first: false });
});

test('cleanName: strips control and bidi marks, keeps 16 characters', () => {
  assert.equal(cleanName('  Ali‮  Veli\u0000 '), 'Ali Veli');
  assert.equal([...cleanName('ÇokUzunBirİsimBuradaVar')].length, 16);
  assert.match(cleanName('   '), /^Player\d{4}$/);
  assert.equal(cleanName('<b>x</b>'), 'bx/b');
});

test('catalog: the two offers of the "Continue?" popup, as the game gives them', () => {
  assert.deepEqual(findProduct('offer_royal_deal'), { id: 'offer_royal_deal', once: false, coins: 0, heartsMin: 60, noAdsMin: 0, giant: 2, bombs: 2 });
  assert.deepEqual(findProduct('offer_special'), { id: 'offer_special', once: false, coins: 1000, heartsMin: 0, noAdsMin: 0, giant: 1, bombs: 0 });
  assert.equal(findProduct('offer_unknown'), null);
});

test('tokens: issue and verify; a wrong secret fails', () => {
  const { token } = issueAccessToken('p_abcdefghijklmnop');
  assert.deepEqual(verifyAccessToken(token), { ok: true, playerId: 'p_abcdefghijklmnop', gen: 0 });
  // An account moved to another device raises the generation its tokens carry.
  assert.deepEqual(verifyAccessToken(issueAccessToken('p_abcdefghijklmnop', 3).token), { ok: true, playerId: 'p_abcdefghijklmnop', gen: 3 });
  assert.equal(verifyAccessToken(token + 'x').ok, false);
  const h = hashDeviceSecret('a'.repeat(64));
  assert.equal(deviceSecretMatches('a'.repeat(64), h), true);
  assert.equal(deviceSecretMatches('b'.repeat(64), h), false);
});

function makeReceipt(purchase: object, privateKey?: import('node:crypto').KeyObject) {
  const json = JSON.stringify(purchase);
  const signature = privateKey ? sign('sha1', Buffer.from(json), privateKey).toString('base64') : '';
  return JSON.stringify({ Store: 'GooglePlay', TransactionID: (purchase as { purchaseToken: string }).purchaseToken, Payload: JSON.stringify({ json, signature }) });
}

test('receipt: parsed from the Unity IAP shape, signature checked with the licensing key', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const licenseKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const purchase = { orderId: 'GPA.1234-5678', packageName: 'com.puzzle.blockescape', productId: 'gold_1000', purchaseTime: 1760000000000, purchaseState: 0, purchaseToken: 'tok_' + 'x'.repeat(60), quantity: 1, acknowledged: false };
  const parsed = parseUnityReceipt(makeReceipt(purchase, privateKey));
  assert.equal(parsed.purchase.productId, 'gold_1000');
  assert.equal(parsed.purchase.orderId, 'GPA.1234-5678');
  assert.equal(signatureValid(parsed.signedData, parsed.signature!, licenseKey), true);
  // The same signature over different contents fails.
  assert.equal(signatureValid(parsed.signedData.replace('gold_1000', 'gold_100000'), parsed.signature!, licenseKey), false);
});

test('receipt: other stores and broken receipts are refused', () => {
  assert.throws(() => parseUnityReceipt(JSON.stringify({ Store: 'fake', Payload: '{}' })), /not verified/);
  assert.throws(() => parseUnityReceipt('not json'), /not JSON/);
});

test('safeForLog: masks secrets, shortens tokens', () => {
  const out = safeForLog({ deviceSecret: 'abc', receipt: 'x'.repeat(100), nested: { token: 't', ok: 1 } }) as Record<string, any>;
  assert.equal(out.deviceSecret, '[REDACTED]');
  assert.match(out.receipt, /…/);
  assert.equal(out.nested.token, '[REDACTED]');
  assert.equal(out.nested.ok, 1);
});

test('TtlCache: one load for many callers at once', async () => {
  const cache = new TtlCache<number>(1000);
  let loads = 0;
  const load = async () => {
    loads++;
    await new Promise((r) => setTimeout(r, 20));
    return 7;
  };
  const values = await Promise.all(Array.from({ length: 50 }, () => cache.getOrLoad('k', load)));
  assert.equal(loads, 1);
  assert.ok(values.every((v) => v === 7));
});

// ── The account and the cloud save ─────────────────────────────────────────────

import { hashPassword, passwordMatches, usernameKey, usernameSchema } from '../src/services/accountService';
import { coinsLookWrong, summarize } from '../src/services/saveService';

test('usernameSchema: 3-16 letters, digits, "_" or "."; any alphabet; no spaces', () => {
  assert.equal(usernameSchema.parse('  Ali_2024 '), 'Ali_2024');
  assert.equal(usernameSchema.parse('Şükrü.Çelik'), 'Şükrü.Çelik');
  assert.equal(usernameSchema.safeParse('ab').success, false);
  assert.equal(usernameSchema.safeParse('ali veli').success, false);
  assert.equal(usernameSchema.safeParse('a'.repeat(17)).success, false);
  assert.equal(usernameSchema.safeParse('<script>').success, false);
});

test('usernameKey: one name whatever its case', () => {
  assert.equal(usernameKey('KingAli'), usernameKey('kingali'));
});

test('passwords: hashed with a salt, checked, wrong ones refused', async () => {
  const a = await hashPassword('1234');
  const b = await hashPassword('1234');
  assert.notEqual(a, b);
  assert.equal(await passwordMatches('1234', a), true);
  assert.equal(await passwordMatches('12345', a), false);
  assert.equal(await passwordMatches('1234', 'nonsense'), false);
  assert.equal(await passwordMatches('1234', null), false);
});

test('summarize: level, coins and boosters out of the progress key', () => {
  const keys = { royal_smash_progress_v1: JSON.stringify({ level: 42, coins: 1234, boosters: { giant: { count: 3, intro: true }, bomb: { count: 2 } } }) };
  assert.deepEqual(summarize(keys), { level: 42, coins: 1234, boosters: { giant: 3, bomb: 2 } });
  assert.deepEqual(summarize({ royal_smash_progress_v1: 'not json' }), { level: 0, coins: 0, boosters: {} });
});

test('coinsLookWrong: purchases and levels allow for the coins', () => {
  assert.equal(coinsLookWrong(5000, 10, 0), false);
  assert.equal(coinsLookWrong(120_000, 10, 100_000), false);
  assert.equal(coinsLookWrong(999_999, 10, 0), true);
});

// ── Invite Friends ─────────────────────────────────────────────────────────────

import { claimableRewards, normalizeCode } from '../src/services/referralService';

test('claimableRewards: one reward per two friends who reached the level, each taken once', () => {
  assert.equal(claimableRewards(0, 0), 0);
  assert.equal(claimableRewards(1, 0), 0);
  assert.equal(claimableRewards(2, 0), 1);
  assert.equal(claimableRewards(5, 1), 1);
  assert.equal(claimableRewards(4, 2), 0);
  assert.equal(claimableRewards(2, 5), 0);
});

test('normalizeCode: upper case, letters and digits only', () => {
  assert.equal(normalizeCode(' ab3-x9k7q '), 'AB3X9K7Q');
  assert.equal(normalizeCode('inv%3D'), 'INV3D');
});
