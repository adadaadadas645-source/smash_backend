import { createHash } from 'crypto';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { col, FieldValue, Timestamp } from '../firebase';
import { currentContext } from '../utils/context';
import { logBusinessEvent, logger, logSecurityEvent } from '../utils/logger';
import { findProduct, Product } from './catalog';
import { checkProductPurchase, googlePlayConfigured, ProductPurchase } from './googlePlay';
import { dbLog } from './logStore';
import { parseUnityReceipt, signatureValid } from './receipt';

/**
 * One purchase, checked once and granted once.
 *
 * kingdom_purchases/{sha256(purchaseToken)} is the record: who it went to, what Google said,
 * what was given. The token's hash is the document id, so the same purchase can never be
 * granted twice, whichever device or player sends it, and a create() in a transaction settles
 * two sends of it at the same moment.
 *
 * The check, strongest first:
 *   1. Google Play Developer API (when the service account has access): real, for this
 *      product, purchased (not canceled or pending), and whether it is a test purchase.
 *   2. The signature Google put on the purchase, with the app's licensing key: not forged.
 * With neither available the answer is 503 and the game keeps the purchase open and asks
 * again later (Unity IAP holds it as pending; nothing is lost).
 */
export type VerifyStatus = 'granted' | 'already_granted' | 'pending' | 'rejected';

export interface VerifyAnswer {
  status: VerifyStatus;
  productId: string;
  orderId: string | null;
  /** Hand over the product now (false for an answer about a purchase already handed over). */
  grant: boolean;
  product: Product | null;
  environment: 'production' | 'test' | 'promo' | 'unknown';
  verifiedBy: 'google_api' | 'signature' | 'record';
  reason?: string;
  tokenHash: string;
}

interface PurchaseDoc {
  tokenHash: string;
  playerId: string;
  productId: string;
  orderId: string | null;
  status: 'granted' | 'rejected';
  reason?: string | null;
  once: boolean;
  environment: VerifyAnswer['environment'];
  verifiedBy: VerifyAnswer['verifiedBy'];
  google?: ProductPurchase | null;
  purchaseTime?: FirebaseFirestore.Timestamp | null;
  grant?: Product | null;
  createdAt: FirebaseFirestore.Timestamp;
  requestId?: string | null;
  appVersion?: string | null;
  owners?: string[];
  tokenPreview: string;
}

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

const envOf = (purchaseType: number | undefined): VerifyAnswer['environment'] =>
  purchaseType === undefined ? 'production' : purchaseType === 0 ? 'test' : purchaseType === 1 ? 'promo' : 'unknown';

export const purchaseService = {
  async verify(playerId: string, input: { receipt: string; productId?: string }): Promise<VerifyAnswer> {
    const parsed = parseUnityReceipt(input.receipt);
    const gp = parsed.purchase;
    const tokenHash = hashToken(gp.purchaseToken);
    const base = { productId: gp.productId, orderId: gp.orderId, tokenHash };
    const ctx = currentContext();
    const logData = { productId: gp.productId, orderId: gp.orderId, tokenHash, claimedProductId: input.productId };

    logger.info(logData, 'purchase: verify started');
    dbLog.event('purchase_verify_started', logData, playerId);

    if (gp.packageName !== config.play.packageName) {
      logSecurityEvent('purchase_wrong_package', { ...logData, packageName: gp.packageName });
      dbLog.security('purchase_wrong_package', { ...logData, packageName: gp.packageName }, playerId);
      return { ...base, status: 'rejected', grant: false, product: null, environment: 'unknown', verifiedBy: 'signature', reason: 'wrong_package' };
    }
    if (input.productId && input.productId !== gp.productId) {
      logSecurityEvent('purchase_product_mismatch', logData);
      dbLog.security('purchase_product_mismatch', logData, playerId);
    }
    const product = findProduct(gp.productId);
    if (!product) throw new AppError(400, 'unknown_product', `Unknown product ${gp.productId}`);

    const ref = col.purchases().doc(tokenHash);

    // Seen before: answer from the record, without asking Google again.
    const seen = await ref.get();
    if (seen.exists) return this.answerFromRecord(seen.data() as PurchaseDoc, playerId, product, base);

    // ── Check it ──────────────────────────────────────────────────────────
    let verifiedBy: VerifyAnswer['verifiedBy'] | null = null;
    let google: ProductPurchase | null = null;
    let unavailableReason: string | null = null;

    if (googlePlayConfigured()) {
      const r = await checkProductPurchase(gp.productId, gp.purchaseToken);
      if (r.kind === 'ok') {
        google = r.purchase;
        verifiedBy = 'google_api';
      } else if (r.kind === 'not_found') {
        return this.reject(ref, playerId, product, base, 'google_unknown_token', 'google_api', null);
      } else unavailableReason = r.reason;
    } else unavailableReason = 'no_service_account';

    if (!verifiedBy && config.play.licenseKey) {
      if (!parsed.signature) return this.reject(ref, playerId, product, base, 'missing_signature', 'signature', null);
      if (!signatureValid(parsed.signedData, parsed.signature, config.play.licenseKey)) {
        return this.reject(ref, playerId, product, base, 'bad_signature', 'signature', null);
      }
      verifiedBy = 'signature';
    }

    if (!verifiedBy) {
      logger.error({ ...logData, unavailableReason }, 'purchase: no way to verify (set Google Play API access or GOOGLE_PLAY_LICENSE_KEY)');
      dbLog.error('purchase_verify_unavailable', new Error(unavailableReason ?? 'unavailable'), logData);
      throw new AppError(503, 'verification_unavailable', 'Purchase verification is not available right now, try again later');
    }

    const state = google ? google.purchaseState : gp.purchaseState;
    if (state === 2) {
      logger.info(logData, 'purchase: pending at Google (slow payment), not granted yet');
      dbLog.event('purchase_pending', logData, playerId);
      return { ...base, status: 'pending', grant: false, product, environment: envOf(google?.purchaseType), verifiedBy };
    }
    if (state === 1) return this.reject(ref, playerId, product, base, 'canceled', verifiedBy, google);
    if (google?.orderId && gp.orderId && google.orderId !== gp.orderId) return this.reject(ref, playerId, product, base, 'order_mismatch', verifiedBy, google);

    const environment = envOf(google?.purchaseType);
    if (environment === 'test' && !config.play.allowTestPurchases) return this.reject(ref, playerId, product, base, 'test_purchase_not_allowed', verifiedBy, google);

    // ── Record and hand over, once ───────────────────────────────────────
    const doc: PurchaseDoc = {
      tokenHash,
      playerId,
      productId: product.id,
      orderId: google?.orderId ?? gp.orderId,
      status: 'granted',
      once: product.once,
      environment,
      verifiedBy,
      google,
      purchaseTime: gp.purchaseTime ? Timestamp.fromMillis(gp.purchaseTime) : google?.purchaseTimeMillis ? Timestamp.fromMillis(Number(google.purchaseTimeMillis)) : null,
      grant: product,
      createdAt: Timestamp.now(),
      requestId: ctx?.requestId ?? null,
      appVersion: ctx?.appVersion ?? null,
      owners: [playerId],
      tokenPreview: `${gp.purchaseToken.slice(0, 8)}…${gp.purchaseToken.slice(-6)}`,
    };
    try {
      await col.purchases().firestore.runTransaction(async (tx) => {
        const again = await tx.get(ref);
        if (again.exists) throw new AppError(409, 'race');
        tx.create(ref, doc);
        const playerUpdate: Record<string, unknown> = {
          purchaseCount: FieldValue.increment(1),
          lastPurchaseAt: FieldValue.serverTimestamp(),
          lastPurchaseProduct: product.id,
        };
        if (product.noAdsMin === -1) playerUpdate.noAdsForever = true;
        if (product.coins > 0) playerUpdate.purchasedCoins = FieldValue.increment(product.coins);
        if (product.giant > 0) playerUpdate.purchasedGiant = FieldValue.increment(product.giant);
        if (product.bombs > 0) playerUpdate.purchasedBombs = FieldValue.increment(product.bombs);
        tx.update(col.players().doc(playerId), playerUpdate);
      });
    } catch (err) {
      if (err instanceof AppError && err.code === 'race') {
        const now = await ref.get();
        return this.answerFromRecord(now.data() as PurchaseDoc, playerId, product, base);
      }
      throw err;
    }

    const done = { ...logData, environment, verifiedBy, orderId: doc.orderId, grant: product };
    logBusinessEvent('purchase_granted', done);
    dbLog.event('purchase_granted', done, playerId);
    return { ...base, orderId: doc.orderId, status: 'granted', grant: true, product, environment, verifiedBy };
  },

  async answerFromRecord(rec: PurchaseDoc, playerId: string, product: Product, base: { productId: string; orderId: string | null; tokenHash: string }): Promise<VerifyAnswer> {
    const common = { ...base, product, environment: rec.environment, verifiedBy: 'record' as const };
    if (rec.status === 'rejected') {
      logger.info({ ...base, reason: rec.reason }, 'purchase: already rejected before');
      return { ...common, status: 'rejected', grant: false, reason: rec.reason ?? 'rejected' };
    }
    if (rec.playerId === playerId || rec.owners?.includes(playerId)) {
      // The game asks again for a purchase it may not have handed over (it crashed, it was
      // reinstalled). It keeps its own list of what it already gave and decides with it.
      logger.info(base, 'purchase: already granted to this player');
      dbLog.event('purchase_already_granted', base, playerId);
      return { ...common, status: 'already_granted', grant: true };
    }
    if (rec.once) {
      // Remove Ads on a new install that made a new player: the same Google account owns it,
      // so it moves with it.
      await col.purchases().doc(rec.tokenHash).update({ owners: FieldValue.arrayUnion(playerId), transferredAt: FieldValue.serverTimestamp(), playerId });
      if (product.noAdsMin === -1) await col.players().doc(playerId).update({ noAdsForever: true });
      const data = { ...base, from: rec.playerId };
      logBusinessEvent('purchase_transferred', data);
      dbLog.event('purchase_transferred', data, playerId);
      return { ...common, status: 'already_granted', grant: true };
    }
    const data = { ...base, owner: rec.playerId };
    logSecurityEvent('purchase_token_reused', data);
    dbLog.security('purchase_token_reused', data, playerId);
    return { ...common, status: 'rejected', grant: false, reason: 'already_used' };
  },

  async reject(
    ref: FirebaseFirestore.DocumentReference,
    playerId: string,
    product: Product,
    base: { productId: string; orderId: string | null; tokenHash: string },
    reason: string,
    verifiedBy: VerifyAnswer['verifiedBy'],
    google: ProductPurchase | null,
  ): Promise<VerifyAnswer> {
    const ctx = currentContext();
    const environment = envOf(google?.purchaseType);
    const doc: Partial<PurchaseDoc> = {
      tokenHash: base.tokenHash,
      playerId,
      productId: product.id,
      orderId: base.orderId,
      status: 'rejected',
      reason,
      once: product.once,
      environment,
      verifiedBy,
      google,
      createdAt: Timestamp.now(),
      requestId: ctx?.requestId ?? null,
      appVersion: ctx?.appVersion ?? null,
      owners: [playerId],
    };
    // A canceled purchase may still be bought again later with a new token; a forged one is
    // kept so the same fake is turned away at once next time.
    await ref.set(doc, { merge: true });
    const data = { ...base, reason, verifiedBy };
    logSecurityEvent('purchase_rejected', data);
    dbLog.security('purchase_rejected', data, playerId);
    return { ...base, status: 'rejected', grant: false, product, environment, verifiedBy, reason };
  },
};
