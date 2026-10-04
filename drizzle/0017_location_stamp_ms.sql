ALTER TABLE "session_booking" ALTER COLUMN "location_changed_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
UPDATE "session_booking" SET "location_changed_at" = date_trunc('milliseconds', "location_changed_at") WHERE "location_changed_at" <> date_trunc('milliseconds', "location_changed_at");
