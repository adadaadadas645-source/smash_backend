import { AsyncLocalStorage } from 'async_hooks';

/**
 * What every log line of one request carries, without passing it around: the request id (the
 * game sends its own X-Request-ID, so the same id is in the device log and here), the player
 * once known, and what the game said about itself in its headers.
 */
export interface RequestContext {
  requestId: string;
  method: string;
  path: string;
  ip?: string;
  playerId?: string;
  appVersion?: string;
  platform?: string;
  deviceModel?: string;
  installId?: string;
}

export const contextStore = new AsyncLocalStorage<RequestContext>();

export const currentContext = (): RequestContext | undefined => contextStore.getStore();

/** Marks the player on the current request (after the token is checked, or on register). */
export function setContextPlayer(playerId: string): void {
  const ctx = contextStore.getStore();
  if (ctx) ctx.playerId = playerId;
}
