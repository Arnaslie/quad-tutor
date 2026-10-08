ALTER TABLE "match_request" ADD COLUMN "notify_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_booking" ADD COLUMN "location_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "session_booking" ADD COLUMN "notify_claimed_at" timestamp with time zone;