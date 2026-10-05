CREATE TABLE "revenuecat_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"user_id" integer,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "token_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "failed_login_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "login_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "last_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cloud_connections" ADD COLUMN "pending_nonce_hash" text;--> statement-breakpoint
ALTER TABLE "cloud_connections" ADD COLUMN "pending_expires_at" timestamp with time zone;--> statement-breakpoint
-- Remove rows left behind by deleted accounts so the foreign keys below can be added.
DELETE FROM "subscriptions" WHERE "user_id" NOT IN (SELECT "id" FROM "users");--> statement-breakpoint
DELETE FROM "referrals" WHERE "referrer_id" NOT IN (SELECT "id" FROM "users");--> statement-breakpoint
DELETE FROM "cloud_connections" WHERE "user_id" NOT IN (SELECT "id" FROM "users");--> statement-breakpoint
DELETE FROM "uploads" WHERE "user_id" NOT IN (SELECT "id" FROM "users");--> statement-breakpoint
DELETE FROM "feedback" WHERE "user_id" NOT IN (SELECT "id" FROM "users");--> statement-breakpoint
DELETE FROM "password_reset_tokens" WHERE "user_id" NOT IN (SELECT "id" FROM "users");--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_id_users_id_fk" FOREIGN KEY ("referrer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_connections" ADD CONSTRAINT "cloud_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "referrals_referrer_idx" ON "referrals" USING btree ("referrer_id");--> statement-breakpoint
CREATE INDEX "referrals_referred_idx" ON "referrals" USING btree ("referred_id");--> statement-breakpoint
CREATE INDEX "cloud_connections_user_idx" ON "cloud_connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "feedback_user_idx" ON "feedback" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_idx" ON "password_reset_tokens" USING btree ("user_id");