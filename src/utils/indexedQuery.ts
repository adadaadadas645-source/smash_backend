import { logger } from './logger';

/**
 * Runs a Firestore query that needs a composite index, falling back to an unordered query when
 * the index is not deployed or still building (gRPC code 9 FAILED_PRECONDITION).
 *
 * Once a missing index is seen, that key falls back directly for COOLDOWN_MS so hot traffic does
 * not pay a failing roundtrip on every request; after the cooldown it tries the fast indexed
 * query again automatically.
 */
const COOLDOWN_MS = 5 * 60_000;
const fallbackUntil = new Map<string, number>();

export function isMissingIndexError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  const msg = typeof e.message === 'string' ? e.message : '';
  return e.code === 9 || e.code === 'failed-precondition' || msg.includes('requires an index') || msg.includes('FAILED_PRECONDITION');
}

export async function runIndexedQuery<T>(
  key: string,
  indexed: () => Promise<T>,
  fallback: () => Promise<T>,
  nowMs: number = Date.now(),
): Promise<{ result: T; usedFallback: boolean }> {
  const until = fallbackUntil.get(key) ?? 0;
  if (until > nowMs) {
    return { result: await fallback(), usedFallback: true };
  }
  try {
    const result = await indexed();
    if (until > 0) fallbackUntil.delete(key);
    return { result, usedFallback: false };
  } catch (err) {
    if (!isMissingIndexError(err)) throw err;
    fallbackUntil.set(key, nowMs + COOLDOWN_MS);
    logger.warn({ key, err: (err as Error).message }, 'firestore: composite index missing/building, using fallback query');
    return { result: await fallback(), usedFallback: true };
  }
}

export function resetIndexFallbacks(): void {
  fallbackUntil.clear();
}
