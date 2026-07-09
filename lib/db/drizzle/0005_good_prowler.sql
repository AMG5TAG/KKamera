ALTER TABLE "users" ADD COLUMN "invite_window_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invite_count" integer DEFAULT 0 NOT NULL;