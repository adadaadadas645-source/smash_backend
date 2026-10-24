import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { contextStore, RequestContext } from '../utils/context';

const header = (req: Request, name: string, max = 80): string | undefined => {
  const v = req.get(name);
  if (!v) return undefined;
  return v.slice(0, max);
};

const ID_PATTERN = /^[A-Za-z0-9._:-]{6,80}$/;

/**
 * Opens the request's context: its id (the game's own X-Request-ID when it is well formed, else
 * a new one), echoed back in the response so a support case can quote it, and what the game
 * says about itself (X-App-Version, X-Platform, X-Device-Model, X-Install-Id).
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get('x-request-id');
  const requestId = incoming && ID_PATTERN.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-ID', requestId);
  const ctx: RequestContext = {
    requestId,
    method: req.method,
    path: req.originalUrl.split('?')[0].slice(0, 200),
    ip: req.ip,
    appVersion: header(req, 'x-app-version', 40),
    platform: header(req, 'x-platform', 20),
    deviceModel: header(req, 'x-device-model'),
    installId: header(req, 'x-install-id', 64),
  };
  (req as Request & { ctx: RequestContext }).ctx = ctx;
  contextStore.run(ctx, () => next());
}
