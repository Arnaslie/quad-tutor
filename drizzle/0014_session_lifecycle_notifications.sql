ALTER TABLE "session_booking" ADD COLUMN "cancel_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_booking" ADD COLUMN "answer_prompted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_booking" ADD COLUMN "settled_notified_at" timestamp with time zone;--> statement-breakpoint
UPDATE "session_booking" SET "cancel_notified_at" = now() WHERE "status" = 'cancelled';--> statement-breakpoint
UPDATE "session_booking" SET "settled_notified_at" = now() WHERE "resolution" IS NOT NULL;
