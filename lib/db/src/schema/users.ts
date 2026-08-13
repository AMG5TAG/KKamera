import { boolean, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  referralCode: text("referral_code").notNull().unique(),
  referrerId: integer("referrer_id"),
  twoFASecret: text("two_fa_secret"),
  twoFAEnabled: boolean("two_fa_enabled").notNull().default(false),
  twoFABackupCodes: text("two_fa_backup_codes"),
  // Set once the user finishes (or skips) the first-run setup wizard. Tracked on
  // the account — not device-local storage — so onboarding shows exactly once per
  // user, regardless of which device or browser they sign in from.
  onboardingCompleted: boolean("onboarding_completed").notNull().default(false),
  // Bumped whenever the password changes; tokens issued before this are rejected.
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
  // Default upload destination when multiple cloud accounts are connected:
  //  - "all"      → every active connection (the historical behaviour)
  //  - "selected" → only the connection ids listed in uploadTargetIds
  //  - "none"     → capture only, don't upload (personal use)
  uploadTargetMode: text("upload_target_mode").notNull().default("all"),
  // CSV of cloud_connections.id used when uploadTargetMode = "selected".
  uploadTargetIds: text("upload_target_ids"),
  // Rolling per-user cap on referral-invite emails (spam/phishing-relay guard),
  // enforced under a row lock so it holds across autoscale instances where an
  // in-memory / per-IP limiter can be bypassed by rotating IPs.
  inviteWindowStart: timestamp("invite_window_start", { withTimezone: true }),
  inviteCount: integer("invite_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
