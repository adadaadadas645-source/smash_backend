import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { config } from '../config';
import { dbLog } from '../services/logStore';
import { currentContext } from '../utils/context';
import { logger } from '../utils/logger';
import { errorInfo } from '../utils/safeLog';

/**
 * An error the server means to answer with: a status and a short code the game can act on
 * (`invalid_token`, `rate_limited`…). Anything else thrown is a bug: logged with its stack,
 * answered with 500 and no details.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = 'AppError';
  }
}

/** Lets an async route throw instead of calling next(err) by hand. */
export const asyncRoute =
  <R extends Request>(fn: (req: R, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req as R, res, next).catch(next);
  };

export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, 'not_found', `No route ${req.method} ${req.path}`));
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const requestId = currentContext()?.requestId;
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    logger.warn({ issues }, 'Validation failed');
    res.status(400).json({ success: false, error: 'invalid_request', issues, requestId });
    return;
  }
  if (err instanceof AppError) {
    const level = err.status >= 500 ? 'error' : 'warn';
    logger[level]({ error: err.code, status: err.status, details: err.details }, err.message);
    if (err.status >= 500) dbLog.error(err.code, err, err.details);
    res.status(err.status).json({ success: false, error: err.code, message: err.message, requestId });
    return;
  }
  // express.json() on a malformed body.
  const e = err as { type?: string; status?: number };
  if (e?.type === 'entity.parse.failed' || e?.type === 'entity.too.large') {
    const status = e.status ?? 400;
    logger.warn({ type: e.type }, 'Body rejected');
    res.status(status).json({ success: false, error: e.type === 'entity.too.large' ? 'body_too_large' : 'invalid_json', requestId });
    return;
  }
  logger.error({ err: errorInfo(err) }, 'Unhandled error');
  dbLog.error('unhandled', err);
  res.status(500).json({
    success: false,
    error: 'internal_error',
    message: config.isProduction ? 'Something went wrong' : (err as Error)?.message,
    requestId,
  });
}
