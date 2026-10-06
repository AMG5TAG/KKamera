import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { pool } from "@workspace/db";
import * as schema from "@workspace/db/schema";
import app from "./app.js";
import { setDatabaseState } from "./routes/health.js";
import { verifyDatabaseSchema } from "./lib/databaseReadiness.js";
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

const DATABASE_CHECK_ATTEMPTS = 3;
const DATABASE_CHECK_BACKOFF_MS = [2_000, 8_000];

/**
 * Replit Publish applies the managed production schema. Validate it read-only
 * rather than replaying migration history that may predate the publish diff.
 */
async function checkDatabaseSchema() {
  const expected = Object.values(schema).flatMap((table) => {
    if (!is(table, PgTable)) return [];
    const config = getTableConfig(table);
    return config.columns.map((column) => ({
      table_schema: config.schema ?? "public",
      table_name: config.name,
      column_name: column.name,
    }));
  });
  await verifyDatabaseSchema(
    (text) => {
      const config = { text, query_timeout: 10_000 };
      return pool.query(config);
    },
    expected,
  );
  logger.info("Database schema verified");
}

/**
 * Check the database with retry + backoff (a cold DB can fail the first
 * connection), tracking state for /api/readyz. Fail closed if required columns
 * are missing, without making any changes to the database.
 */
async function checkDatabaseWithRetry() {
  for (let attempt = 1; attempt <= DATABASE_CHECK_ATTEMPTS; attempt++) {
    try {
      await checkDatabaseSchema();
      setDatabaseState("ok");
      return;
    } catch (err) {
      if (attempt === DATABASE_CHECK_ATTEMPTS) {
        setDatabaseState("failed");
        logger.fatal(
          { err, attempts: attempt },
          "Database schema check failed — refusing API traffic (503) until restarted",
        );
        return;
      }
      const delay = DATABASE_CHECK_BACKOFF_MS[attempt - 1] ?? 8_000;
      logger.warn({ err, attempt, retryInMs: delay }, "Database schema check failed — retrying");
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// Bind before checking the database so cold-start latency cannot prevent port
// detection. API traffic remains gated until the read-only schema check passes.
app.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
});

// /api/readyz reports database availability separately from process liveness.
void checkDatabaseWithRetry();
