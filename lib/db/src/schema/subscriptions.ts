import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const subscriptionsTable = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique().references(() => usersTable.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("none"),
  trialStart: timestamp("trial_start", { withTimezone: true }),
  trialEnd: timestamp("trial_end", { withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  // Number of referral "free year" milestones already granted to this user.
  // Used to make milestone awarding idempotent against RevenueCat webhook replays.
  freeYearsAwarded: integer("free_years_awarded").notNull().default(0),
  // Event time of the newest RevenueCat webhook applied to this row, so an older
  // event delivered late (or replayed) can't overwrite newer state.
  lastEventAt: timestamp("last_event_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// RevenueCat webhook event ids already processed, so a redelivered event is
// acknowledged without being applied twice.
export const revenueCatEventsTable = pgTable("revenuecat_events", {
  eventId: text("event_id").primaryKey(),
  userId: integer("user_id"),
  type: text("type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSubscriptionSchema = createInsertSchema(subscriptionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type Subscription = typeof subscriptionsTable.$inferSelect;
