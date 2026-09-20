ALTER TABLE "session_booking" ADD COLUMN "student_denied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_booking" ADD COLUMN "tutor_denied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_booking" ADD COLUMN "denial_note" text;