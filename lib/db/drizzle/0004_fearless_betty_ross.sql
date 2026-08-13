ALTER TABLE "users" ADD COLUMN "upload_target_mode" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "upload_target_ids" text;--> statement-breakpoint
ALTER TABLE "cloud_connections" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "cloud_connections" ADD COLUMN "account_label" text;