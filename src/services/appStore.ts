import { createPrivateKey, sign } from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import { errorInfo } from '../utils/safeLog';

/**
 * The App Store Server API for one purchase: asks Apple itself for a transaction by its id and
 * reads back what Apple says it is (product, bundle, environment, refund). Needs an In-App
 * Purchase key from App Store Connect (Users and Access -> Integrations -> In-App Purchase):
 * APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID and APPLE_IAP_PRIVATE_KEY (the .p8 text). The answer
 * comes over TLS from Apple to a request signed with that key, so its signed transaction is
 * read as Apple sent it.
 *
 * Production and the sandbox (TestFlight and sandbox testers) are asked at once; the sandbox's
 * answer counts only for a transaction production does not know (404).
 */
export interface AppleTransaction {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  purchaseDate?: number;
  quantity?: number;
  type?: string; // Consumable, Non-Consumable, ...
  environment?: 'Production' | 'Sandbox' | string;
  revocationDate?: number;
  revocationReason?: number;
  storefront?: string;
  appAccountToken?: string;
  transactionReason?: string;
  price?: number;
  currency?: string;
}

export type AppleCheck =
  | { kind: 'ok'; transaction: AppleTransaction }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; status?: number; reason: string };

const HOSTS = {
  Production: 'https://api.storekit.itunes.apple.com',
  Sandbox: 'https://api.storekit-sandbox.itunes.apple.com',
} as const;

export const appStoreConfigured = () => !!(config.apple.keyId && config.apple.issuerId && config.apple.privateKey);

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

let cachedToken: { value: string; until: number } | null = null;

/** The request's bearer token: ES256 JWT with the In-App Purchase key, good for 20 minutes (reused for 15). */
function bearer(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.until > now) return cachedToken.value;
  const header = { alg: 'ES256', kid: config.apple.keyId, typ: 'JWT' };
  const payload = { iss: config.apple.issuerId, iat: now, exp: now + 20 * 60, aud: 'appstoreconnect-v1', bid: config.apple.bundleId };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = createPrivateKey(config.apple.privateKey as string);
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  const value = `${unsigned}.${b64url(signature)}`;
  cachedToken = { value, until: now + 15 * 60 };
  return value;
}

/** The payload of a JWS Apple returned (signedTransactionInfo). */
export function jwsPayload<T>(jws: string): T {
  const part = jws.split('.')[1];
  if (!part) throw new Error('not a JWS');
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as T;
}

async function ask(env: keyof typeof HOSTS, transactionId: string): Promise<AppleCheck> {
  const url = `${HOSTS[env]}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`;
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer()}` }, signal: AbortSignal.timeout(10_000) });
    const durationMs = Date.now() - started;
    if (res.status === 404) return { kind: 'not_found' };
    if (!res.ok) {
      logger.error({ env, status: res.status, durationMs }, 'appStore: transaction lookup failed');
      return { kind: 'unavailable', status: res.status, reason: res.status === 401 ? 'no_permission' : 'apple_error' };
    }
    const body = (await res.json()) as { signedTransactionInfo?: string };
    if (!body.signedTransactionInfo) return { kind: 'unavailable', status: res.status, reason: 'empty_answer' };
    const transaction = jwsPayload<AppleTransaction>(body.signedTransactionInfo);
    logger.info({ env, durationMs, productId: transaction.productId, transactionId: transaction.transactionId, environment: transaction.environment }, 'appStore: transaction checked');
    return { kind: 'ok', transaction };
  } catch (err) {
    logger.error({ env, durationMs: Date.now() - started, err: errorInfo(err) }, 'appStore: lookup error');
    return { kind: 'unavailable', reason: 'network' };
  }
}

/**
 * For /health/deep: Apple's answer to a transaction that does not exist, from the sandbox. 404 is
 * the healthy answer (the key signs in, the transaction is simply unknown); 401 is a key Apple
 * refuses; an error is one that never reached Apple (a .p8 that does not read, the network).
 */
export async function appStoreProbe(): Promise<string> {
  if (!appStoreConfigured()) return 'no_iap_key';
  try {
    const res = await fetch(`${HOSTS.Sandbox}/inApps/v1/transactions/1`, { headers: { Authorization: `Bearer ${bearer()}` }, signal: AbortSignal.timeout(10_000) });
    return res.status === 404 ? 'ok' : `apple_${res.status}`;
  } catch (err) {
    return `error: ${(err as Error).message}`.slice(0, 160);
  }
}

export async function checkTransaction(transactionId: string): Promise<AppleCheck> {
  if (!appStoreConfigured()) return { kind: 'unavailable', reason: 'no_iap_key' };
  // Both environments at once: a sandbox purchase (TestFlight, App Review) waited for production's
  // 404 first, two round trips to Apple before the game heard back. Production's answer wins.
  const [prod, sandbox] = await Promise.all([ask('Production', transactionId), ask('Sandbox', transactionId)]);
  if (prod.kind !== 'not_found') return prod;
  return sandbox;
}
