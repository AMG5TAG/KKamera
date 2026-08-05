import path from "path";
import { runMigrations as runDbMigrations } from "@workspace/db/migrate";
import app from "./app.js";
import { logger } from "./lib/logger.js";

// A rejected promise with no handler is logged rather than crashing the whole
// instance (Node exits on an unhandled rejection by default). Routes are
// individually try/caught, so reaching this is unexpected.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
});
// After an uncaught exception the process may be in an undefined state — log and
// exit so the platform restarts a clean instance rather than serving from a
// potentially corrupted runtime.
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — exiting for a clean restart");
  process.exit(1);
});

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

// Listen FIRST so the health-check probe succeeds immediately — do NOT await
// migrations before binding. In production (autoscale / Cloud Run), the
// deployer only gives the container ~60 s to open its port; if the database
// connection is slow on cold-start the old ordering caused the process to be
// killed before it ever called listen(). Migrations are idempotent and guarded
// by a Postgres advisory lock, so running them concurrently with the first
// requests is safe: DB-touching routes will get a brief connection error during
// migration (rare) rather than the whole deployment failing every time.
app.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
});

// Run migrations in the background after the port is open.
runAppMigrations().catch((err) => {
  logger.error({ err }, "Database migration failed — server is running but schema may be out of date");
});
