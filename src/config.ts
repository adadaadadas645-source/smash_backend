import 'dotenv/config';
import { z } from 'zod';

/**
 * Every setting the server reads, checked once at start. A missing or malformed value stops the
 * server with a clear message instead of failing on the first request that needs it.
 */
const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number.parseInt(v, 10)))
    .pipe(z.number().int());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: int(4000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),

  /** Service account JSON (one line), the same variable the Avenia server uses. */
  FIREBASE_SERVICE_ACCOUNT_KEY: z.string().optional(),
  FIREBASE_PROJECT_ID: z.string().optional(),
  /** Prefix for every collection, so this game's data never mixes with another app in the same project. */
  COLLECTION_PREFIX: z.string().default('kingdom_'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL_DAYS: int(30),
  /** Mixed into the stored hash of each device secret. */
  DEVICE_SECRET_PEPPER: z.string().min(16, 'DEVICE_SECRET_PEPPER must be at least 16 characters'),

  /** Long random value for the /admin endpoints (x-admin-key header). Empty: admin endpoints are off. */
  ADMIN_API_KEY: z.string().optional(),

  ANDROID_PACKAGE_NAME: z.string().default('com.puzzle.blockescape'),
  /** Service account allowed to call the Google Play Developer API. Falls back to the Firebase one. */
  GOOGLE_PLAY_SERVICE_ACCOUNT_KEY: z.string().optional(),
  /** Play Console -> Monetization setup -> Licensing: the Base64 RSA public key of the app. */
  GOOGLE_PLAY_LICENSE_KEY: z.string().optional(),
  /** Test purchases (license testers, closed test) are granted when true. */
  ALLOW_TEST_PURCHASES: bool(true),

  LEADERBOARD_MAX_LEVEL: int(5000),
  LEADERBOARD_TOP_LIMIT: int(100),
  LEADERBOARD_CACHE_SECONDS: int(30),

  /** Every API request is also written to Firestore (kingdom_logs), buffered, off the request path. */
  LOG_REQUESTS_TO_DB: bool(true),
  /** Days a log row is kept (Firestore TTL policy on expireAt). */
  LOG_RETENTION_DAYS: int(30),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // The logger is not up yet; this is the one place that writes to stderr directly.
  // eslint-disable-next-line no-console
  console.error('Invalid environment:', JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

const env = parsed.data;

export const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isRender: process.env.RENDER === 'true',
  port: env.PORT,
  logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'production' ? 'info' : 'debug'),
  version: process.env.RENDER_GIT_COMMIT?.slice(0, 7) || process.env.npm_package_version || 'dev',

  firebase: {
    serviceAccountKey: env.FIREBASE_SERVICE_ACCOUNT_KEY,
    projectId: env.FIREBASE_PROJECT_ID,
  },
  collections: {
    players: `${env.COLLECTION_PREFIX}players`,
    leaderboard: `${env.COLLECTION_PREFIX}leaderboard`,
    purchases: `${env.COLLECTION_PREFIX}purchases`,
    logs: `${env.COLLECTION_PREFIX}logs`,
    usernames: `${env.COLLECTION_PREFIX}usernames`,
    saves: `${env.COLLECTION_PREFIX}saves`,
    invites: `${env.COLLECTION_PREFIX}invites`,
    referrals: `${env.COLLECTION_PREFIX}referrals`,
  },

  jwt: {
    secret: env.JWT_SECRET,
    ttlDays: env.JWT_TTL_DAYS,
    issuer: 'kingdom-backend',
    audience: 'kingdom-smash',
  },
  deviceSecretPepper: env.DEVICE_SECRET_PEPPER,
  adminApiKey: env.ADMIN_API_KEY || null,

  play: {
    packageName: env.ANDROID_PACKAGE_NAME,
    serviceAccountKey: env.GOOGLE_PLAY_SERVICE_ACCOUNT_KEY || env.FIREBASE_SERVICE_ACCOUNT_KEY,
    licenseKey: env.GOOGLE_PLAY_LICENSE_KEY || null,
    allowTestPurchases: env.ALLOW_TEST_PURCHASES,
  },

  leaderboard: {
    maxLevel: env.LEADERBOARD_MAX_LEVEL,
    topLimit: Math.min(200, Math.max(10, env.LEADERBOARD_TOP_LIMIT)),
    cacheMs: Math.max(5, env.LEADERBOARD_CACHE_SECONDS) * 1000,
  },

  logs: {
    toDb: env.LOG_REQUESTS_TO_DB,
    retentionDays: Math.max(1, env.LOG_RETENTION_DAYS),
  },
};

export type Config = typeof config;
