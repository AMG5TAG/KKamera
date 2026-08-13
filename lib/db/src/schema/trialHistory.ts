import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Records that an email has already consumed its one free trial, so deleting the
// account and re-registering the same email can't farm unlimited 14-day trials.
// We store only an HMAC of the normalised email (keyed by SESSION_SECRET), never
// the address itself — this row intentionally OUTLIVES account deletion.
export const trialHistoryTable = pgTable("trial_history", {
  id: serial("id").primaryKey(),
  emailHash: text("email_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertTrialHistorySchema = createInsertSchema(trialHistoryTable).omit({ id: true, createdAt: true });
export type InsertTrialHistory = z.infer<typeof insertTrialHistorySchema>;
export type TrialHistory = typeof trialHistoryTable.$inferSelect;
