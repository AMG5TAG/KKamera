CREATE TABLE IF NOT EXISTS "trial_history" (
        "id" serial PRIMARY KEY NOT NULL,
        "email_hash" text NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "trial_history_email_hash_unique" UNIQUE("email_hash")
);
