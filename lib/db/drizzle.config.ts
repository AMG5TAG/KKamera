import { defineConfig } from "drizzle-kit";
import path from "path";

// `drizzle-kit generate` diffs the schema offline and needs no DB connection;
// only push/migrate actually connect, and they fail clearly if the URL is unset.
export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  out: path.join(__dirname, "./drizzle"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
