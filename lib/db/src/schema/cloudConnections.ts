import { boolean, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const cloudConnectionsTable = pgTable("cloud_connections", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  type: text("type").notNull(),
  name: text("name").notNull(),
  // Stable provider account identifier (Google permissionId/email, Microsoft
  // drive/owner id, Dropbox account_id). Lets a personal and a business account
  // of the same provider coexist, and reconnecting the SAME account refresh its
  // tokens instead of stacking a duplicate. Null when identity lookup failed.
  accountId: text("account_id"),
  // Human-readable account label (email or display name) shown in the UI so the
  // user can tell their connected accounts apart. Best-effort; may be null.
  accountLabel: text("account_label"),
  host: text("host"),
  port: integer("port"),
  username: text("username"),
  passwordEncrypted: text("password_encrypted"),
  uploadPath: text("upload_path"),
  accessTokenEncrypted: text("access_token_encrypted"),
  refreshToken: text("refresh_token"),
  tokenExpiry: timestamp("token_expiry", { withTimezone: true }),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertCloudConnectionSchema = createInsertSchema(cloudConnectionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCloudConnection = z.infer<typeof insertCloudConnectionSchema>;
export type CloudConnection = typeof cloudConnectionsTable.$inferSelect;
