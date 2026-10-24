import { config } from '../config';
import { col, Timestamp } from '../firebase';
import { currentContext } from '../utils/context';
import { logger } from '../utils/logger';
import { errorInfo, safeForLog } from '../utils/safeLog';

/**
 * The searchable record in Firestore (kingdom_logs), next to the stdout logs of Render: one row
 * per API request, per business event (a purchase, a level, a ban), per error and per report
 * from the game itself. Rows are queued in memory and written in batches every couple of
 * seconds, never on the request's own path, so a slow write never slows a player down and a
 * burst of traffic turns into a few batch writes. Each row has expireAt, for a Firestore TTL
 * policy that deletes it after LOG_RETENTION_DAYS.
 */
export type LogKind = 'request' | 'event' | 'security' | 'error' | 'client';

export interface LogRow {
  kind: LogKind;
  name: string;
  level: 'info' | 'warn' | 'error';
  requestId?: string;
  playerId?: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  ip?: string;
  appVersion?: string;
  platform?: string;
  deviceModel?: string;
  data?: unknown;
}

const FLUSH_MS = 2000;
const BATCH_MAX = 450; // Firestore allows 500 writes per batch.
const QUEUE_MAX = 10000;

let queue: Array<Record<string, unknown>> = [];
let dropped = 0;
let flushing: Promise<void> | null = null;
let timer: NodeJS.Timeout | null = null;

function enqueue(row: LogRow): void {
  if (!config.logs.toDb) return;
  const now = Date.now();
  const ctx = currentContext();
  const doc: Record<string, unknown> = {
    at: Timestamp.fromMillis(now),
    atIso: new Date(now).toISOString(),
    expireAt: Timestamp.fromMillis(now + config.logs.retentionDays * 86400000),
    kind: row.kind,
    name: row.name,
    level: row.level,
    requestId: row.requestId ?? ctx?.requestId ?? null,
    playerId: row.playerId ?? ctx?.playerId ?? null,
    method: row.method ?? ctx?.method ?? null,
    path: row.path ?? ctx?.path ?? null,
    status: row.status ?? null,
    durationMs: row.durationMs ?? null,
    ip: row.ip ?? ctx?.ip ?? null,
    appVersion: row.appVersion ?? ctx?.appVersion ?? null,
    platform: row.platform ?? ctx?.platform ?? null,
    deviceModel: row.deviceModel ?? ctx?.deviceModel ?? null,
    serverVersion: config.version,
    data: row.data === undefined ? null : safeForLog(row.data),
  };
  if (queue.length >= QUEUE_MAX) {
    queue.shift();
    dropped++;
  }
  queue.push(doc);
  if (queue.length >= BATCH_MAX) void flush();
}

async function writeOnce(rows: Array<Record<string, unknown>>): Promise<void> {
  const batch = col.logs().firestore.batch();
  for (const r of rows) batch.set(col.logs().doc(), r);
  await batch.commit();
}

export function flush(): Promise<void> {
  if (flushing) return flushing;
  if (queue.length === 0) return Promise.resolve();
  flushing = (async () => {
    try {
      while (queue.length > 0) {
        const rows = queue.splice(0, BATCH_MAX);
        try {
          await writeOnce(rows);
        } catch (err) {
          // Back to the front, to try again on the next tick; the server keeps running.
          queue = rows.concat(queue).slice(-QUEUE_MAX);
          logger.error({ err: errorInfo(err), pending: queue.length }, 'logStore: batch write failed');
          break;
        }
      }
      if (dropped > 0) {
        logger.warn({ dropped }, 'logStore: queue was full, oldest rows dropped');
        dropped = 0;
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

export function startLogStore(): void {
  if (!config.logs.toDb || timer) return;
  timer = setInterval(() => void flush(), FLUSH_MS);
  timer.unref();
  logger.info({ collection: config.collections.logs, retentionDays: config.logs.retentionDays }, 'logStore started');
}

export async function stopLogStore(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await flush();
}

export const dbLog = {
  request: (row: Omit<LogRow, 'kind' | 'name' | 'level'> & { level?: LogRow['level'] }) =>
    enqueue({ kind: 'request', name: `${row.method} ${row.path}`, level: row.level ?? 'info', ...row }),
  event: (name: string, data?: unknown, playerId?: string) => enqueue({ kind: 'event', name, level: 'info', data, playerId }),
  security: (name: string, data?: unknown, playerId?: string) => enqueue({ kind: 'security', name, level: 'warn', data, playerId }),
  error: (name: string, err: unknown, data?: unknown) =>
    enqueue({ kind: 'error', name, level: 'error', data: { error: errorInfo(err), ...(data as object) } }),
  client: (name: string, level: LogRow['level'], data?: unknown) => enqueue({ kind: 'client', name, level, data }),
};
