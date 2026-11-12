// Must stay the first import: validates production env before anything else
// (notably @workspace/db) is evaluated. See lib/bootEnv.ts.
import "./lib/bootEnv.js";
import path from "path";
import { pool } from "@workspace/db";
import { runMigrations as runDbMigrations } from "@workspace/db/migrate";
import app from "./app.js";
import { setMigrationState, setShuttingDown } from "./routes/health.js";
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

const MIGRATION_ATTEMPTS = 3;
const MIGRATION_BACKOFF_MS = [2_000, 8_000];

/**
 * Apply versioned Drizzle migrations so a fresh database is fully provisioned on
 * boot (no manual `push` step) and existing databases stay in sync. The baseline
 * migration is idempotent, so this is safe to run on every start.
 */
async function runAppMigrations() {
  // No DATABASE_URL check needed: @workspace/db throws at import without it.
  // Migration SQL lives in lib/db/drizzle at the repo root. From the bundled
  // entry (artifacts/api-server/dist/index.mjs) that is three levels up.
  const migrationsFolder = path.resolve(import.meta.dirname, "../../../lib/db/drizzle");
  await runDbMigrations(migrationsFolder);
  logger.info("Database migrations applied");
}

/**
 * Run migrations with retry + backoff (a cold DB often fails the first
 * connection), tracking state for /api/readyz. After the final failure the
 * instance refuses API traffic (503) rather than serving on a stale schema.
 */
async function migrateWithRetry() {
  for (let attempt = 1; attempt <= MIGRATION_ATTEMPTS; attempt++) {
    try {
      await runAppMigrations();
      setMigrationState("ok");
      return;
    } catch (err) {
      if (attempt === MIGRATION_ATTEMPTS) {
        setMigrationState("failed");
        logger.fatal(
          { err, attempts: attempt },
          "Database migration failed — refusing API traffic (503) until restarted",
        );
        return;
      }
      const delay = MIGRATION_BACKOFF_MS[attempt - 1] ?? 8_000;
      logger.warn({ err, attempt, retryInMs: delay }, "Database migration attempt failed — retrying");
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// Listen FIRST so the health-check probe succeeds immediately — do NOT await
// migrations before binding. In production (autoscale / Cloud Run), the
// deployer only gives the container ~60 s to open its port; if the database
// connection is slow on cold-start the old ordering caused the process to be
// killed before it ever called listen(). Migrations are idempotent and guarded
// by a Postgres advisory lock, so running them concurrently with the first
// requests is safe: DB-touching routes will get a brief connection error during
// migration (rare) rather than the whole deployment failing every time.
const server = app.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
});

// Node's default requestTimeout (300 s) would cut off a large video on a slow
// uplink long before the app gives up: its XHR timeout scales with file size up
// to 60 min (uploadTimeoutMs in artifacts/kkamera/contexts/UploadContext.tsx).
// Allow the whole body that long plus a margin; headers must still arrive
// promptly (slowloris), so headersTimeout stays short.
const MAX_CLIENT_UPLOAD_MS = 60 * 60_000;
server.requestTimeout = MAX_CLIENT_UPLOAD_MS + 5 * 60_000;
server.headersTimeout = 60_000;

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// Autoscale sends SIGTERM before stopping an instance. Stop accepting new
// connections, report not-ready, give in-flight requests (uploads can be long)
// up to SHUTDOWN_GRACE_MS to finish — best effort, the platform may SIGKILL
// sooner — then force-close what's left, close the DB pool and exit.
const DEFAULT_SHUTDOWN_GRACE_MS = 25_000;
const rawGrace = Number(process.env["SHUTDOWN_GRACE_MS"]);
const SHUTDOWN_GRACE_MS = Number.isFinite(rawGrace) && rawGrace >= 0 ? rawGrace : DEFAULT_SHUTDOWN_GRACE_MS;

let shutdownStarted = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) {
    logger.warn({ signal }, "Shutdown already in progress — ignoring signal");
    return;
  }
  shutdownStarted = true;
  setShuttingDown();
  logger.info({ signal, graceMs: SHUTDOWN_GRACE_MS }, "Shutting down — draining in-flight requests");

  const drained = new Promise<void>((resolve) => {
    // Stops listening; resolves once every connection has ended. Idle
    // keep-alive sockets are closed immediately (Node >= 19).
    server.close(() => resolve());
    server.closeIdleConnections();
  });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), SHUTDOWN_GRACE_MS);
  });
  const outcome = await Promise.race([drained.then(() => "drained" as const), deadline]);
  clearTimeout(timer);
  if (outcome === "timeout") {
    logger.warn({ graceMs: SHUTDOWN_GRACE_MS }, "Shutdown grace period elapsed — closing remaining connections");
    server.closeAllConnections();
  }

  try {
    await Promise.race([pool.end(), new Promise((r) => setTimeout(r, 5_000))]);
  } catch (err) {
    logger.error({ err }, "Error closing database pool");
  }
  logger.info("Shutdown complete");
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => { void shutdown(signal); });
}

// Run migrations in the background after the port is open. /api/readyz
// reports progress; a definitive failure turns API routes into 503s.
void migrateWithRetry();
