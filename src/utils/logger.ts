import pino from 'pino';
import { currentContext } from './context';

/**
 * pino, as in Avenia: JSON lines on stdout (Render keeps and searches them), pretty in local
 * development. Every line made while a request runs carries its requestId, playerId, method
 * and path by itself (the mixin), so a search for one player or one request finds all of it.
 */
const isDevelopment = (process.env.NODE_ENV || 'development') === 'development';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  base: { service: 'kingdom-backend' },
  timestamp: pino.stdTimeFunctions.isoTime,
  messageKey: 'msg',
  formatters: {
    level: (label) => ({ level: label.toUpperCase() }),
  },
  mixin() {
    const ctx = currentContext();
    if (!ctx) return {};
    return {
      requestId: ctx.requestId,
      playerId: ctx.playerId,
      method: ctx.method,
      path: ctx.path,
    };
  },
  redact: {
    paths: [
      'authorization',
      'headers.authorization',
      '*.authorization',
      '*.token',
      '*.deviceSecret',
      '*.*.deviceSecret',
      '*.signature',
      '*.*.signature',
      '*.accessToken',
      '*.*.token',
    ],
    censor: '[REDACTED]',
  },
  transport: isDevelopment
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service' } }
    : undefined,
});

/** Something the game did that matters later (a purchase, a level, a ban). */
export function logBusinessEvent(event: string, data: Record<string, unknown> = {}): void {
  logger.info({ businessEvent: event, ...data }, `Business: ${event}`);
}

/** Something that looks like abuse or an attack. */
export function logSecurityEvent(event: string, data: Record<string, unknown> = {}): void {
  logger.warn({ securityEvent: event, ...data }, `Security: ${event}`);
}
