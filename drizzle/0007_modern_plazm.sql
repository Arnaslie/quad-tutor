ALTER TABLE "match_request" ADD COLUMN "tutor_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "match_request" ADD COLUMN "student_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_booking" ADD COLUMN "booked_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_booking" ADD COLUMN "reminded_at" timestamp with time zone;