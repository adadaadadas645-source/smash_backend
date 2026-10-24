import { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { dbLog } from '../services/logStore';
import { currentContext } from '../utils/context';
import { logger } from '../utils/logger';
import { safeForLog } from '../utils/safeLog';

/**
 * One line when a request comes in (with its body, secrets masked) and one when its answer goes
 * out (status, time, and the answer's body), as Avenia's routeLogger does, plus the same pair as
 * one row in kingdom_logs. A request that the client gave up on is logged as aborted.
 */
const SKIP = new Set(['/health', '/favicon.ico']);
const SLOW_MS = 1500;

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  if (SKIP.has(req.path)) return next();
  const started = process.hrtime.bigint();
  const ctx = currentContext();

  logger.info(
    {
      step: 'request_received',
      ip: req.ip,
      query: safeForLog(req.query),
      body: safeForLog(req.body),
      appVersion: ctx?.appVersion,
      platform: ctx?.platform,
      deviceModel: ctx?.deviceModel,
      installId: ctx?.installId,
      userAgent: req.get('user-agent'),
      contentLength: req.get('content-length'),
    },
    `→ ${req.method} ${req.originalUrl}`,
  );

  let responseBody: unknown;
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    responseBody = body;
    return originalJson(body);
  }) as Response['json'];

  let done = false;
  const finish = (aborted: boolean) => {
    if (done) return;
    done = true;
    const durationMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
    const status = res.statusCode;
    const level: 'info' | 'warn' | 'error' = aborted || status >= 500 ? 'error' : status >= 400 || durationMs > SLOW_MS ? 'warn' : 'info';
    const response = safeForLog(responseBody);
    logger[level](
      { step: aborted ? 'response_aborted' : 'response_sent', requestId: ctx?.requestId, playerId: ctx?.playerId, status, durationMs, response, slow: durationMs > SLOW_MS || undefined },
      `← ${req.method} ${req.originalUrl} ${status} ${durationMs}ms${aborted ? ' (aborted)' : ''}`,
    );
    if (config.logs.toDb) {
      dbLog.request({
        level,
        requestId: ctx?.requestId,
        playerId: ctx?.playerId,
        ip: ctx?.ip,
        appVersion: ctx?.appVersion,
        platform: ctx?.platform,
        deviceModel: ctx?.deviceModel,
        method: req.method,
        path: ctx?.path,
        status,
        durationMs,
        data: {
          aborted: aborted || undefined,
          query: Object.keys(req.query || {}).length ? req.query : undefined,
          body: req.body && Object.keys(req.body).length ? req.body : undefined,
          response,
          installId: ctx?.installId,
          userAgent: req.get('user-agent'),
        },
      });
    }
  };
  res.on('finish', () => finish(false));
  res.on('close', () => {
    if (!res.writableEnded) finish(true);
  });
  next();
}
