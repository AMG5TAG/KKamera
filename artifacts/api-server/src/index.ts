import { runMigrations } from "stripe-replit-sync";
import { getStripeSync } from "./stripeClient.js";
import { pool } from "@workspace/db";
import app from "./app.js";
import { logger } from "./lib/logger.js";

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required but was not provided.");
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

const sessionSecret = process.env["SESSION_SECRET"];
if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error(
    "SESSION_SECRET environment variable must be set and at least 32 characters long. " +
    "Generate one with: openssl rand -hex 32"
  );
}

/** Idempotent schema migrations — add new columns/tables without wiping data. */
async function runAppMigrations() {
  if (!process.env.DATABASE_URL) return;
  // Run each statement independently so one failure can't leave a half-applied
  // batch. Optional column adds are best-effort; the reset-tokens table is
  // required, so its failure is fatal rather than silently masked.
  const optional = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_backup_codes TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ`,
    `ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS free_years_awarded INTEGER NOT NULL DEFAULT 0`,
  ];
  for (const stmt of optional) {
    try {
      await pool.query(stmt);
    } catch (err) {
      logger.error({ err, stmt }, "Optional schema migration failed — continuing");
    }
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL,
      token_hash      TEXT    NOT NULL UNIQUE,
      expires_at      TIMESTAMPTZ NOT NULL,
      used_at         TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  logger.info("App schema migrations applied");
}

async function initStripe() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.warn("DATABASE_URL not set — skipping Stripe initialisation");
    return;
  }
  try {
    logger.info("Initialising Stripe schema...");
    await runMigrations({ databaseUrl });
    logger.info("Stripe schema ready");

    const stripeSync = await getStripeSync();

    const webhookBaseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`;
    await stripeSync.findOrCreateManagedWebhook(`${webhookBaseUrl}/api/stripe/webhook`);
    logger.info("Stripe webhook configured");

    // Backfill in background — don't block server startup
    stripeSync.syncBackfill()
      .then(() => logger.info("Stripe backfill complete"))
      .catch((err) => logger.error({ err }, "Stripe backfill error"));
  } catch (err) {
    logger.error({ err }, "Stripe init failed — continuing without Stripe");
  }
}

await runAppMigrations();
await initStripe();

app.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
});
