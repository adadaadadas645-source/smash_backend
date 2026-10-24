import { config } from './config';
import compression from 'compression';
import express from 'express';
import helmet from 'helmet';
import { pingFirestore } from './firebase';
import { errorHandler, notFound } from './middleware/errorHandler';
import { limits } from './middleware/rateLimits';
import { requestContext } from './middleware/requestContext';
import { requestLogger } from './middleware/requestLogger';
import { createAdminRouter } from './routes/admin';
import { createAuthRouter } from './routes/auth';
import { createClientLogRouter } from './routes/clientLogs';
import { createLeaderboardRouter } from './routes/leaderboard';
import { createPlayerRouter } from './routes/players';
import { createPurchaseRouter } from './routes/purchases';
import { googlePlayConfigured } from './services/googlePlay';
import { dbLog, startLogStore, stopLogStore } from './services/logStore';
import { logger } from './utils/logger';
import { errorInfo } from './utils/safeLog';

const API = '/api/v1';
const started = new Date();

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Render puts one proxy in front: req.ip is then the player's address, not the proxy's.
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(compression());
  app.use(requestContext);
  app.use(express.json({ limit: '64kb' }));
  app.use(requestLogger);
  app.use(limits.global);

  // Render's own probe when no health check path is set: answered without a log line.
  app.all('/', (_req, res) => {
    res.status(200).json({ ok: true, service: 'kingdom-backend' });
  });
  app.get('/health', (_req, res) => {
    res.json({ ok: true, version: config.version, uptimeS: Math.round(process.uptime()), startedAt: started.toISOString() });
  });
  app.get('/health/deep', async (_req, res) => {
    try {
      const firestoreMs = await pingFirestore();
      res.json({ ok: true, firestoreMs, googlePlayApi: googlePlayConfigured(), licenseKey: !!config.play.licenseKey, version: config.version });
    } catch (err) {
      logger.error({ err: errorInfo(err) }, 'Deep health check failed');
      res.status(503).json({ ok: false, error: 'firestore_unreachable' });
    }
  });

  const mount = (path: string, router: express.Router, name: string) => {
    app.use(path, router);
    logger.info({ route: name, path }, 'Route mounted');
  };
  mount(`${API}/auth`, createAuthRouter(), 'auth');
  mount(`${API}/players`, createPlayerRouter(), 'players');
  mount(`${API}/leaderboard`, createLeaderboardRouter(), 'leaderboard');
  mount(`${API}/purchases`, createPurchaseRouter(), 'purchases');
  mount(`${API}/logs`, createClientLogRouter(), 'clientLogs');
  mount(`${API}/admin`, createAdminRouter(), 'admin');

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

function start(): void {
  logger.info(
    {
      env: config.env,
      version: config.version,
      isRender: config.isRender,
      collections: config.collections,
      googlePlayApi: googlePlayConfigured(),
      licenseKey: !!config.play.licenseKey,
      allowTestPurchases: config.play.allowTestPurchases,
      logsToDb: config.logs.toDb,
      admin: !!config.adminApiKey,
    },
    'Kingdom backend starting',
  );
  if (!googlePlayConfigured() && !config.play.licenseKey) {
    logger.warn('Neither Google Play API access nor GOOGLE_PLAY_LICENSE_KEY is set: purchases will answer 503 until one is');
  }
  startLogStore();
  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'Server listening');
    dbLog.event('server_started', { version: config.version });
  });
  // No request hangs on forever; idle connections outlive Render's proxy (60 s) so it reuses them.
  server.requestTimeout = 30_000;
  server.headersTimeout = 31_000;
  server.keepAliveTimeout = 65_000;

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Shutting down: no new connections, writing the last logs');
    server.close(async () => {
      await stopLogStore().catch(() => undefined);
      logger.info('Stopped');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: errorInfo(reason) }, 'Unhandled promise rejection');
    dbLog.error('unhandled_rejection', reason);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: errorInfo(err) }, 'Uncaught exception, restarting');
    void stopLogStore().finally(() => process.exit(1));
  });
}

if (require.main === module) start();
