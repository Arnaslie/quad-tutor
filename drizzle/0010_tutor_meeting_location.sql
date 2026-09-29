ALTER TABLE "session_booking" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "session_booking" ADD COLUMN "student_note" text;--> statement-breakpoint
ALTER TABLE "session_booking" ADD COLUMN "notified_location" text;--> statement-breakpoint
ALTER TABLE "tutor_profile" ADD COLUMN "default_location" text;--> statement-breakpoint
UPDATE "session_booking" SET "student_note" = "location_note" WHERE "location_note" IS NOT NULL;