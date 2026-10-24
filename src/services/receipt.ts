import { createPublicKey, verify as cryptoVerify } from 'crypto';
import { AppError } from '../middleware/errorHandler';

/**
 * The receipt Unity IAP hands the game for a Google Play purchase:
 *   { "Store": "GooglePlay", "TransactionID": "<purchaseToken>", "Payload": "<string>" }
 * and Payload, itself JSON:
 *   { "json": "<the purchase, as Google signed it>", "signature": "<base64>", ... }
 * The purchase JSON is what Google signed: its productId, purchaseToken, orderId and
 * packageName are the ones to trust, not whatever else the game sends next to it.
 */
export interface GooglePurchase {
  orderId: string | null;
  packageName: string;
  productId: string;
  purchaseTime: number | null;
  purchaseState: number | null;
  purchaseToken: string;
  quantity: number;
  acknowledged: boolean | null;
}

export interface ParsedReceipt {
  store: string;
  purchase: GooglePurchase;
  /** Exactly the signed text, for the signature check. */
  signedData: string;
  signature: string | null;
}

const parseJson = (s: unknown, what: string): Record<string, unknown> => {
  if (typeof s !== 'string') throw new AppError(400, 'invalid_receipt', `${what} is not a string`);
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object') return v as Record<string, unknown>;
  } catch {
    /* below */
  }
  throw new AppError(400, 'invalid_receipt', `${what} is not JSON`);
};

export function parseUnityReceipt(raw: string): ParsedReceipt {
  const outer = parseJson(raw, 'receipt');
  const store = String(outer.Store ?? '');
  if (store !== 'GooglePlay') throw new AppError(400, 'store_not_supported', `Store "${store}" is not verified by this server`);
  const payload = parseJson(outer.Payload, 'receipt.Payload');
  const signedData = payload.json;
  if (typeof signedData !== 'string') throw new AppError(400, 'invalid_receipt', 'receipt.Payload.json missing');
  const p = parseJson(signedData, 'receipt.Payload.json');
  const purchaseToken = typeof p.purchaseToken === 'string' ? p.purchaseToken : typeof outer.TransactionID === 'string' ? outer.TransactionID : '';
  if (!purchaseToken || typeof p.productId !== 'string' || typeof p.packageName !== 'string') {
    throw new AppError(400, 'invalid_receipt', 'purchase JSON lacks productId, packageName or purchaseToken');
  }
  return {
    store,
    signedData,
    signature: typeof payload.signature === 'string' && payload.signature.length > 0 ? payload.signature : null,
    purchase: {
      orderId: typeof p.orderId === 'string' ? p.orderId : null,
      packageName: p.packageName,
      productId: p.productId,
      purchaseTime: typeof p.purchaseTime === 'number' ? p.purchaseTime : null,
      purchaseState: typeof p.purchaseState === 'number' ? p.purchaseState : null,
      purchaseToken,
      quantity: typeof p.quantity === 'number' ? p.quantity : 1,
      acknowledged: typeof p.acknowledged === 'boolean' ? p.acknowledged : null,
    },
  };
}

let cachedKey: { b64: string; key: ReturnType<typeof createPublicKey> } | null = null;

/** Google signs the purchase JSON with the app's licensing key (SHA1withRSA). */
export function signatureValid(signedData: string, signatureB64: string, licenseKeyB64: string): boolean {
  if (!cachedKey || cachedKey.b64 !== licenseKeyB64) {
    cachedKey = { b64: licenseKeyB64, key: createPublicKey({ key: Buffer.from(licenseKeyB64.replace(/\s+/g, ''), 'base64'), format: 'der', type: 'spki' }) };
  }
  try {
    return cryptoVerify('sha1', Buffer.from(signedData, 'utf8'), cachedKey.key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}
