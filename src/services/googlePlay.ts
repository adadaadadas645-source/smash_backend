import { GoogleAuth } from 'google-auth-library';
import { config } from '../config';
import { logger } from '../utils/logger';
import { errorInfo } from '../utils/safeLog';

/**
 * The Google Play Developer API (androidpublisher v3) for one-time products: asks Google itself
 * whether a purchase token is real, for which product, and in what state. Needs a service
 * account that was invited in Play Console (Users and permissions) with "View financial data"
 * and "Manage orders", and the "Google Play Android Developer API" switched on in its Cloud
 * project. Until then every call fails with 401/403 and the server falls back to the signature.
 */
export interface ProductPurchase {
  purchaseState?: number; // 0 purchased, 1 canceled, 2 pending
  consumptionState?: number; // 0 yet to be consumed, 1 consumed
  acknowledgementState?: number;
  purchaseType?: number; // absent: real money; 0 test (license tester), 1 promo code, 2 rewarded
  orderId?: string;
  purchaseTimeMillis?: string;
  regionCode?: string;
  quantity?: number;
  obfuscatedExternalAccountId?: string;
}

export type PlayCheck =
  | { kind: 'ok'; purchase: ProductPurchase }
  | { kind: 'not_found'; status: number }
  | { kind: 'unavailable'; status?: number; reason: string };

let auth: GoogleAuth | null = null;

function client(): GoogleAuth | null {
  if (auth) return auth;
  if (!config.play.serviceAccountKey) return null;
  try {
    auth = new GoogleAuth({ credentials: JSON.parse(config.play.serviceAccountKey), scopes: ['https://www.googleapis.com/auth/androidpublisher'] });
    return auth;
  } catch (err) {
    logger.error({ err: errorInfo(err) }, 'googlePlay: service account JSON unreadable');
    return null;
  }
}

export const googlePlayConfigured = () => !!config.play.serviceAccountKey;

export async function checkProductPurchase(productId: string, token: string): Promise<PlayCheck> {
  const c = client();
  if (!c) return { kind: 'unavailable', reason: 'no_service_account' };
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(config.play.packageName)}` +
    `/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`;
  const started = Date.now();
  try {
    const res = await c.request<ProductPurchase>({ url, method: 'GET', timeout: 10000, retry: true });
    logger.info({ productId, durationMs: Date.now() - started, purchaseState: res.data.purchaseState, purchaseType: res.data.purchaseType, orderId: res.data.orderId }, 'googlePlay: purchase checked');
    return { kind: 'ok', purchase: res.data };
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    const durationMs = Date.now() - started;
    if (status === 400 || status === 404 || status === 410) {
      logger.warn({ productId, status, durationMs }, 'googlePlay: token not known to Google');
      return { kind: 'not_found', status };
    }
    logger.error({ productId, status, durationMs, err: errorInfo(err) }, 'googlePlay: check failed');
    return { kind: 'unavailable', status, reason: status === 401 || status === 403 ? 'no_permission' : 'google_error' };
  }
}
