import * as admin from 'firebase-admin';
import { config } from './config';
import { logger } from './utils/logger';

/**
 * Firebase Admin, set up the way the Avenia server does it: the service account JSON in
 * FIREBASE_SERVICE_ACCOUNT_KEY, or the machine's default credentials when it is absent (local
 * development with `gcloud auth application-default login`).
 */
function init(): admin.app.App {
  if (admin.apps.length) return admin.app();
  const raw = config.firebase.serviceAccountKey;
  if (raw) {
    let account: admin.ServiceAccount & { project_id?: string };
    try {
      account = JSON.parse(raw);
    } catch (err) {
      logger.fatal({ err }, 'FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON');
      process.exit(1);
    }
    const app = admin.initializeApp({
      credential: admin.credential.cert(account),
      projectId: config.firebase.projectId || account.project_id,
    });
    logger.info({ projectId: app.options.projectId }, 'Firebase Admin initialized with service account');
    return app;
  }
  const app = admin.initializeApp(config.firebase.projectId ? { projectId: config.firebase.projectId } : undefined);
  logger.warn({ projectId: config.firebase.projectId }, 'Firebase Admin initialized with default credentials');
  return app;
}

export const firebaseApp = init();
export const db = admin.firestore(firebaseApp);
// Optional fields left out of a write are simply not stored (no "undefined" errors).
db.settings({ ignoreUndefinedProperties: true });

export const FieldValue = admin.firestore.FieldValue;
export const Timestamp = admin.firestore.Timestamp;

export const col = {
  players: () => db.collection(config.collections.players),
  leaderboard: () => db.collection(config.collections.leaderboard),
  purchases: () => db.collection(config.collections.purchases),
  logs: () => db.collection(config.collections.logs),
};

/** A cheap read that proves the credentials and the database work (used by /health/deep). */
export async function pingFirestore(): Promise<number> {
  const started = Date.now();
  await col.players().limit(1).get();
  return Date.now() - started;
}
