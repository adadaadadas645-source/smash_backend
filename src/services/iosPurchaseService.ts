import { createHash } from 'crypto';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { col, FieldValue, Timestamp } from '../firebase';
import { currentContext } from '../utils/context';
import { logBusinessEvent, logger, logSecurityEvent } from '../utils/logger';
import { AppleTransaction, checkTransaction } from './appStore';
import { findProduct, Product } from './catalog';
import { dbLog } from './logStore';

/**
 * One App Store purchase, checked once and granted once: the iOS twin of purchaseService
 * (Google Play), with its own collection, kingdom_purchases_ios, so the two stores never mix.
 *
 * kingdom_purchases_ios/{sha256(originalTransactionId)} is the record. A consumable's original
 * transaction is itself; Remove Ads (non-consumable) keeps its original transaction id when it
 * is restored on another device, so a restore lands on the same record and moves to the new
 * player, as on Android.
 *
 * The check is Apple's own answer (App Store Server API, appStore.ts): the transaction exists,
 * is for this app's bundle and this product, is not refunded, and whether it is a sandbox one.
 * Without the In-App Purchase key the answer is 503 and the game keeps the purchase open and
 * asks again later.
 */
export type IosVerifyStatus = 'granted' | 'already_granted' | 'rejected';

export interface IosVerifyAnswer {
  status: IosVerifyStatus;
  productId: string;
  transactionId: string;
  /** Hand over the product now (false for an answer about a purchase already handed over). */
  grant: boolean;
  product: Product | null;
  environment: 'production' | 'sandbox' | 'unknown';
  verifiedBy: 'app_store_api' | 'record';
  reason?: string;
  tokenHash: string;
}

interface IosPurchaseDoc {
  store: 'app_store';
  tokenHash: string;
  playerId: string;
  productId: string;
  transactionId: string;
  originalTransactionId: string;
  status: 'granted' | 'rejected';
  reason?: string | null;
  once: boolean;
  environment: IosVerifyAnswer['environment'];
  apple?: AppleTransaction | null;
  purchaseTime?: FirebaseFirestore.Timestamp | null;
  grant?: Product | null;
  createdAt: FirebaseFirestore.Timestamp;
  requestId?: string | null;
  appVersion?: string | null;
  owners?: string[];
}

const hashId = (t: string) => createHash('sha256').update(`ios:${t}`).digest('hex');

const envOf = (t: AppleTransaction | null): IosVerifyAnswer['environment'] =>
  !t?.environment ? 'unknown' : t.environment === 'Production' ? 'production' : t.environment === 'Sandbox' ? 'sandbox' : 'unknown';

/**
 * The transaction id the game sends: Unity IAP's receipt for the App Store is
 *   { "Store": "AppleAppStore", "TransactionID": "<id>", "Payload": "<app receipt>" }
 * Only the id is used; everything about the purchase comes from Apple.
 */
export function transactionIdOf(input: { receipt?: string; transactionId?: string }): string {
  if (input.transactionId) return input.transactionId;
  if (!input.receipt) throw new AppError(400, 'invalid_receipt', 'receipt or transactionId is required');
  let outer: Record<string, unknown>;
  try {
    outer = JSON.parse(input.receipt);
  } catch {
    throw new AppError(400, 'invalid_receipt', 'receipt is not JSON');
  }
  const store = String(outer.Store ?? '');
  if (store !== 'AppleAppStore') throw new AppError(400, 'store_not_supported', `Store "${store}" is not an App Store receipt`);
  const id = outer.TransactionID;
  if (typeof id !== 'string' || !/^\d{1,32}$/.test(id)) throw new AppError(400, 'invalid_receipt', 'receipt.TransactionID missing');
  return id;
}

export const iosPurchaseService = {
  async verify(playerId: string, input: { receipt?: string; transactionId?: string; productId?: string }): Promise<IosVerifyAnswer> {
    const transactionId = transactionIdOf(input);
    const logData = { store: 'app_store', transactionId, claimedProductId: input.productId };
    logger.info(logData, 'purchase ios: verify started');
    dbLog.event('purchase_ios_verify_started', logData, playerId);

    const r = await checkTransaction(transactionId);
    if (r.kind === 'unavailable') {
      logger.error({ ...logData, reason: r.reason }, 'purchase ios: no way to verify (set APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID, APPLE_IAP_PRIVATE_KEY)');
      dbLog.error('purchase_ios_verify_unavailable', new Error(r.reason), logData);
      throw new AppError(503, 'verification_unavailable', 'Purchase verification is not available right now, try again later');
    }
    if (r.kind === 'not_found') {
      // Not known to Apple in either environment: forged or for another app.
      const data = { ...logData, reason: 'apple_unknown_transaction' };
      logSecurityEvent('purchase_ios_rejected', data);
      dbLog.security('purchase_ios_rejected', data, playerId);
      return { status: 'rejected', productId: input.productId ?? '', transactionId, grant: false, product: null, environment: 'unknown', verifiedBy: 'app_store_api', reason: 'apple_unknown_transaction', tokenHash: hashId(transactionId) };
    }

    const t = r.transaction;
    const tokenHash = hashId(t.originalTransactionId || t.transactionId);
    const base = { productId: t.productId, transactionId: t.transactionId, tokenHash };
    const data = { ...logData, productId: t.productId, originalTransactionId: t.originalTransactionId, environment: t.environment };

    if (t.bundleId !== config.apple.bundleId) {
      logSecurityEvent('purchase_ios_wrong_bundle', { ...data, bundleId: t.bundleId });
      dbLog.security('purchase_ios_wrong_bundle', { ...data, bundleId: t.bundleId }, playerId);
      return { ...base, status: 'rejected', grant: false, product: null, environment: envOf(t), verifiedBy: 'app_store_api', reason: 'wrong_bundle' };
    }
    if (input.productId && input.productId !== t.productId) {
      logSecurityEvent('purchase_ios_product_mismatch', data);
      dbLog.security('purchase_ios_product_mismatch', data, playerId);
    }
    const product = findProduct(t.productId);
    if (!product) throw new AppError(400, 'unknown_product', `Unknown product ${t.productId}`);

    const ref = col.purchasesIos().doc(tokenHash);
    const seen = await ref.get();
    if (seen.exists) return this.answerFromRecord(seen.data() as IosPurchaseDoc, playerId, product, base, t);

    if (t.revocationDate) return this.reject(ref, playerId, product, base, 'refunded', t);
    const environment = envOf(t);
    if (environment === 'sandbox' && !config.apple.allowSandboxPurchases) return this.reject(ref, playerId, product, base, 'sandbox_purchase_not_allowed', t);

    const ctx = currentContext();
    const doc: IosPurchaseDoc = {
      store: 'app_store',
      tokenHash,
      playerId,
      productId: product.id,
      transactionId: t.transactionId,
      originalTransactionId: t.originalTransactionId || t.transactionId,
      status: 'granted',
      once: product.once,
      environment,
      apple: t,
      purchaseTime: t.purchaseDate ? Timestamp.fromMillis(t.purchaseDate) : null,
      grant: product,
      createdAt: Timestamp.now(),
      requestId: ctx?.requestId ?? null,
      appVersion: ctx?.appVersion ?? null,
      owners: [playerId],
    };
    try {
      await col.purchasesIos().firestore.runTransaction(async (tx) => {
        const again = await tx.get(ref);
        if (again.exists) throw new AppError(409, 'race');
        tx.create(ref, doc);
        const playerUpdate: Record<string, unknown> = {
          purchaseCount: FieldValue.increment(1),
          iosPurchaseCount: FieldValue.increment(1),
          lastPurchaseAt: FieldValue.serverTimestamp(),
          lastPurchaseProduct: product.id,
          lastPurchaseStore: 'app_store',
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
        return this.answerFromRecord(now.data() as IosPurchaseDoc, playerId, product, base, t);
      }
      throw err;
    }

    const done = { ...data, environment, grant: product };
    logBusinessEvent('purchase_ios_granted', done);
    dbLog.event('purchase_ios_granted', done, playerId);
    return { ...base, status: 'granted', grant: true, product, environment, verifiedBy: 'app_store_api' };
  },

  async answerFromRecord(
    rec: IosPurchaseDoc,
    playerId: string,
    product: Product,
    base: { productId: string; transactionId: string; tokenHash: string },
    now: AppleTransaction,
  ): Promise<IosVerifyAnswer> {
    const common = { ...base, product, environment: rec.environment, verifiedBy: 'record' as const };
    if (rec.status === 'rejected') {
      logger.info({ ...base, reason: rec.reason }, 'purchase ios: already rejected before');
      return { ...common, status: 'rejected', grant: false, reason: rec.reason ?? 'rejected' };
    }
    if (now.revocationDate) {
      // Refunded since it was granted: nothing more is given for it.
      await col.purchasesIos().doc(rec.tokenHash).update({ revokedAt: Timestamp.fromMillis(now.revocationDate), revocationReason: now.revocationReason ?? null });
      logSecurityEvent('purchase_ios_refunded', base);
      dbLog.security('purchase_ios_refunded', base, playerId);
      return { ...common, status: 'rejected', grant: false, reason: 'refunded' };
    }
    if (rec.playerId === playerId || rec.owners?.includes(playerId)) {
      logger.info(base, 'purchase ios: already granted to this player');
      dbLog.event('purchase_ios_already_granted', base, playerId);
      return { ...common, status: 'already_granted', grant: true };
    }
    if (rec.once) {
      // Remove Ads restored on another device (same Apple ID, same original transaction): it moves with it.
      await col.purchasesIos().doc(rec.tokenHash).update({ owners: FieldValue.arrayUnion(playerId), transferredAt: FieldValue.serverTimestamp(), playerId });
      if (product.noAdsMin === -1) await col.players().doc(playerId).update({ noAdsForever: true });
      const data = { ...base, from: rec.playerId };
      logBusinessEvent('purchase_ios_transferred', data);
      dbLog.event('purchase_ios_transferred', data, playerId);
      return { ...common, status: 'already_granted', grant: true };
    }
    const data = { ...base, owner: rec.playerId };
    logSecurityEvent('purchase_ios_transaction_reused', data);
    dbLog.security('purchase_ios_transaction_reused', data, playerId);
    return { ...common, status: 'rejected', grant: false, reason: 'already_used' };
  },

  async reject(
    ref: FirebaseFirestore.DocumentReference,
    playerId: string,
    product: Product,
    base: { productId: string; transactionId: string; tokenHash: string },
    reason: string,
    t: AppleTransaction,
  ): Promise<IosVerifyAnswer> {
    const ctx = currentContext();
    const environment = envOf(t);
    const doc: Partial<IosPurchaseDoc> = {
      store: 'app_store',
      tokenHash: base.tokenHash,
      playerId,
      productId: product.id,
      transactionId: t.transactionId,
      originalTransactionId: t.originalTransactionId || t.transactionId,
      status: 'rejected',
      reason,
      once: product.once,
      environment,
      apple: t,
      createdAt: Timestamp.now(),
      requestId: ctx?.requestId ?? null,
      appVersion: ctx?.appVersion ?? null,
      owners: [playerId],
    };
    await ref.set(doc, { merge: true });
    const data = { ...base, reason };
    logSecurityEvent('purchase_ios_rejected', data);
    dbLog.security('purchase_ios_rejected', data, playerId);
    return { ...base, status: 'rejected', grant: false, product, environment, verifiedBy: 'app_store_api', reason };
  },
};
