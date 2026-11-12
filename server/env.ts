import "server-only"
import { z } from "zod"

/**
 * Typed, validated environment. Import `env` instead of touching
 * process.env so a misconfigured deployment fails at boot with a clear
 * message rather than at the first request that needs the value.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:4100"),
  APP_NAME: z.string().default("Game Slots"),
  /**
   * The domain arena subdomains hang off: `{slug}.APP_ROOT_DOMAIN`. Defaults
   * to the host of APP_URL, which keeps a single-arena deployment working
   * without configuration.
   */
  APP_ROOT_DOMAIN: z.string().optional(),

  // Database: when DATABASE_URL is unset we run an embedded Postgres (PGlite).
  DATABASE_URL: z.string().optional(),
  PGLITE_DATA_DIR: z.string().default("./.data/pglite"),

  // Secrets — required outside development.
  SESSION_SECRET: z.string().min(32).optional(),
  /**
   * Encrypts credentials we store and must read back, such as each arena's
   * payment provider keys. Separate from SESSION_SECRET so it can be rotated
   * on its own schedule; falls back to it outside production.
   */
  CREDENTIALS_KEY: z.string().min(32).optional(),
  QR_SECRET: z.string().min(32).optional(),
  CRON_SECRET: z.string().min(16).optional(),

  // Payments
  PAYMENT_PROVIDER: z.enum(["mock", "paystack"]).default("mock"),
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_PUBLIC_KEY: z.string().optional(),

  // Media storage
  // local: disk — development, and a single server with a durable volume.
  // s3:    any S3-compatible object store (Oracle Cloud Object Storage, MinIO, R2).
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  /** e.g. https://<namespace>.compat.objectstorage.<region>.oraclecloud.com */
  STORAGE_ENDPOINT: z.string().url().optional(),
  STORAGE_REGION: z.string().default("us-ashburn-1"),
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  /** Public read URL, when it differs from `${endpoint}/${bucket}`. */
  STORAGE_PUBLIC_URL: z.string().url().optional(),
  UPLOAD_DIR: z.string().default("./storage/uploads"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),

  // Google sign-in (optional). "Continue with Google" appears only when both are set.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // Email
  EMAIL_PROVIDER: z.enum(["console", "resend"]).default("console"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Game Slots <no-reply@localhost>"),

  // First admin account, created only when the database has no users.
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),

  // Observability
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n")
  throw new Error(`Invalid environment configuration:\n${issues}`)
}

const raw = parsed.data
const isProd = raw.NODE_ENV === "production"
// `next build` runs with NODE_ENV=production but has no runtime secrets; the
// strict checks apply when the server actually starts.
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build"
const enforce = isProd && !isBuildPhase

function requireInProd(name: string, value: string | undefined, fallback: string) {
  if (value) return value
  if (enforce) throw new Error(`${name} must be set in production`)
  return fallback
}

export const env = {
  ...raw,
  isProd,
  isTest: raw.NODE_ENV === "test",
  googleEnabled: Boolean(raw.GOOGLE_CLIENT_ID && raw.GOOGLE_CLIENT_SECRET),
  SESSION_SECRET: requireInProd(
    "SESSION_SECRET",
    raw.SESSION_SECRET,
    "dev-only-session-secret-change-me-0123456789"
  ),
  QR_SECRET: requireInProd("QR_SECRET", raw.QR_SECRET, "dev-only-qr-secret-change-me-0123456789"),
  CRON_SECRET: raw.CRON_SECRET ?? (isProd ? undefined : "dev-cron-secret"),
}

if (enforce && env.PAYMENT_PROVIDER === "mock") {
  throw new Error("PAYMENT_PROVIDER=mock is not allowed in production")
}
// The embedded database is a development convenience: it is a file on local
// disk, so it cannot be shared between processes and does not survive a
// container being replaced. Production runs real Postgres.
if (enforce && !env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required in production: the embedded database cannot persist there.")
}
if (env.STORAGE_DRIVER === "s3" && !isBuildPhase) {
  const missing = (["STORAGE_ENDPOINT", "STORAGE_BUCKET", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY"] as const).filter(
    (key) => !env[key]
  )
  if (missing.length > 0) {
    throw new Error(`STORAGE_DRIVER=s3 needs ${missing.join(", ")}. See docs/DEPLOYMENT.md for the Object Storage setup.`)
  }
}
// Local uploads live on the container's own disk. That is fine for one server
// with a mounted volume and silently lossy for anything else, so it is stated
// rather than assumed.
if (enforce && env.STORAGE_DRIVER === "local" && !process.env.ALLOW_LOCAL_UPLOADS) {
  throw new Error(
    "STORAGE_DRIVER=local in production stores uploads on the container's disk, which is lost when it is replaced. Use s3, or set ALLOW_LOCAL_UPLOADS=1 if the upload directory is a persistent volume."
  )
}
if (env.PAYMENT_PROVIDER === "paystack" && !env.PAYSTACK_SECRET_KEY) {
  throw new Error("PAYSTACK_SECRET_KEY is required when PAYMENT_PROVIDER=paystack")
}
