/**
 * Makes any value safe to put in a log line or a log document: long strings cut, long arrays
 * cut, deep objects stopped, and every secret-looking field masked. (jsonLogging.ts of Avenia,
 * with the masking added, since request bodies here carry device secrets and purchase tokens.)
 */
const MAX_STRING = 2000;
const MAX_ARRAY = 50;
const MAX_DEPTH = 5;

const SECRET_KEYS = new Set([
  'authorization',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'devicesecret',
  'secret',
  'password',
  'x-admin-key',
  'signature',
]);

/** Kept, but only the start and the end, so a support search can still match it. */
const PARTIAL_KEYS = new Set(['purchasetoken', 'receipt']);

export function mask(value: string): string {
  if (value.length <= 12) return '***';
  return `${value.slice(0, 6)}…${value.slice(-4)} (${value.length})`;
}

export function safeForLog(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[max-depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING}]` : value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length}>`;
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => safeForLog(v, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`[+${value.length - MAX_ARRAY} more]`);
    return out;
  }
  if (typeof (value as { toDate?: unknown }).toDate === 'function') {
    try {
      return (value as { toDate: () => Date }).toDate().toISOString();
    } catch {
      /* fall through */
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (SECRET_KEYS.has(key)) out[k] = v ? '[REDACTED]' : v;
    else if (PARTIAL_KEYS.has(key) && typeof v === 'string') out[k] = mask(v);
    else out[k] = safeForLog(v, depth + 1);
  }
  return out;
}

export function errorInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const extra = err as Error & { code?: unknown; status?: unknown; statusCode?: unknown; details?: unknown };
    return {
      name: err.name,
      message: err.message,
      code: extra.code,
      status: extra.status ?? extra.statusCode,
      details: safeForLog(extra.details),
      stack: err.stack?.split('\n').slice(0, 8).join('\n'),
    };
  }
  return { message: String(err) };
}
