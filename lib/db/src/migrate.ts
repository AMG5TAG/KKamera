import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./index";

// A fixed key for a Postgres session advisory lock. When several autoscale
// instances cold-start at once, only one runs the migrations at a time; the
// others block here until it finishes, then see an up-to-date schema.
const MIGRATION_LOCK_KEY = 728_193_645;

/**
 * Apply all pending Drizzle migrations from `migrationsFolder`. Idempotent and
 * safe to call on every boot — already-applied migrations are skipped via the
 * drizzle migrations table.
 */
export async function runMigrations(migrationsFolder: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await migrate(db, { migrationsFolder });
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
