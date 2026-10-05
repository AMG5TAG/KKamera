import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const uploadsTable = pgTable("uploads", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  fileType: text("file_type").notNull(),
  status: text("status").notNull().default("pending"),
  connectionIds: text("connection_ids"),
  error: text("error"),
  // Client-generated id for one capture (the app's queue item id). Lets a retried
  // request be recognised as the same upload instead of creating a duplicate.
  clientUploadId: text("client_upload_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  index("uploads_user_created_idx").on(t.userId, t.createdAt),
  uniqueIndex("uploads_user_client_upload_id_idx").on(t.userId, t.clientUploadId),
]);

export const insertUploadSchema = createInsertSchema(uploadsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUpload = z.infer<typeof insertUploadSchema>;
export type Upload = typeof uploadsTable.$inferSelect;
