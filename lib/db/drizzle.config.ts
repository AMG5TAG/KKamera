import { defineConfig } from "drizzle-kit";
import path from "path";

// `drizzle-kit generate` diffs the schema offline and needs no DB connection;
// only push/migrate actually connect, and they fail clearly if the URL is unset.
export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  // Relative (not absolute) so drizzle-kit resolves migration snapshots correctly
  // — it prepends "./" to `out`, which corrupts an absolute path. generate/migrate
  // run with cwd = lib/db. The runtime migrator resolves its own folder path.
  out: "drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
