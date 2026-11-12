CREATE TABLE "rate_limit_hits" (
	"key" text PRIMARY KEY NOT NULL,
	"hits" integer NOT NULL,
	"reset_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "witness_window_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "witness_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "store_original_transaction_id" text;--> statement-breakpoint
ALTER TABLE "cloud_connections" ADD COLUMN "trust_self_signed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_connections" ADD COLUMN "tls_pin_sha256" text;--> statement-breakpoint
ALTER TABLE "email_verifications" ADD COLUMN "referrer_id" integer;--> statement-breakpoint
CREATE INDEX "rate_limit_hits_reset_idx" ON "rate_limit_hits" USING btree ("reset_at");