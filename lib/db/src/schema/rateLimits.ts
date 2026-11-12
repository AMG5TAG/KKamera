import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Fixed-window hit counters shared by every API instance (express-rate-limit
// store + per-(account, IP) sign-in throttle — see api-server lib/rateLimitStore.ts).
// One row per limiter key; a hit past resetAt starts a new window. Expired rows
// are deleted periodically.
export const rateLimitHitsTable = pgTable("rate_limit_hits", {
  key: text("key").primaryKey(),
  hits: integer("hits").notNull(),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
}, (t) => [index("rate_limit_hits_reset_idx").on(t.resetAt)]);
