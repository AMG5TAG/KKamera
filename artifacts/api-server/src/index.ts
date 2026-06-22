import path from "path";
import { runMigrations as runStripeMigrations } from "stripe-replit-sync";
import { getStripeSync } from "./stripeClient.js";
import { runMigrations as runDbMigrations } from "@workspace/db/migrate";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { getPublicBaseUrl } from "./lib/appUrl.js";

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

/**
 * Apply versioned Drizzle migrations so a fresh database is fully provisioned on
 * boot (no manual `push` step) and existing databases stay in sync. The baseline
 * migration is idempotent, so this is safe to run on every start.
 */
async function runAppMigrations() {
  if (!process.env.DATABASE_URL) {
    logger.warn("DATABASE_URL not set — skipping migrations");
    return;
  }
  // Migration SQL lives in lib/db/drizzle at the repo root. From the bundled
  // entry (artifacts/api-server/dist/index.mjs) that is three levels up.
  const migrationsFolder = path.resolve(import.meta.dirname, "../../../lib/db/drizzle");
  await runDbMigrations(migrationsFolder);
  logger.info("Database migrations applied");
}

async function initStripe() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.warn("DATABASE_URL not set — skipping Stripe initialisation");
    return;
  }
  try {
    logger.info("Initialising Stripe schema...");
    await runStripeMigrations({ databaseUrl });
    logger.info("Stripe schema ready");

    const stripeSync = await getStripeSync();

    await stripeSync.findOrCreateManagedWebhook(`${getPublicBaseUrl()}/api/stripe/webhook`);
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
