import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// One row per verification code sent. A code is bound to the client that asked
// for it (nonceHash, returned only to that client), so a code emailed because
// someone else registered the address can't be redeemed from another device.
// passwordHash/name carry the credentials of the registration that created the
// row, applied to the account only when this row's code is verified.
export const emailVerificationsTable = pgTable("email_verifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  nonceHash: text("nonce_hash").notNull().unique(),
  codeHash: text("code_hash").notNull(),
  passwordHash: text("password_hash"),
  name: text("name"),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("email_verifications_user_idx").on(t.userId)]);

export type EmailVerification = typeof emailVerificationsTable.$inferSelect;
