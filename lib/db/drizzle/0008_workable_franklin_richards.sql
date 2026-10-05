ALTER TABLE "users" ADD COLUMN "trial_reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "client_upload_id" text;--> statement-breakpoint
CREATE INDEX "uploads_user_created_idx" ON "uploads" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uploads_user_client_upload_id_idx" ON "uploads" USING btree ("user_id","client_upload_id");