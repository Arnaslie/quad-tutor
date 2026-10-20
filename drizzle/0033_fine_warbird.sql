CREATE TYPE "public"."payout_speed" AS ENUM('weekly', 'daily');--> statement-breakpoint
ALTER TABLE "tutor_profile" ADD COLUMN "payout_speed" "payout_speed" DEFAULT 'weekly' NOT NULL;