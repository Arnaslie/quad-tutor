ALTER TYPE "public"."engagement_status" ADD VALUE 'pending_payment' BEFORE 'active';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'processor_fee';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'tutor_transfer';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'transfer_reversal';--> statement-breakpoint
ALTER TYPE "public"."session_status" ADD VALUE 'held' BEFORE 'scheduled';--> statement-breakpoint
DROP INDEX "engagement_match_request_idx";--> statement-breakpoint
ALTER TABLE "engagement" ADD COLUMN "stripe_checkout_session_id" text;--> statement-breakpoint
ALTER TABLE "engagement" ADD COLUMN "checkout_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entry_stripe_reference_idx" ON "ledger_entry" USING btree ("stripe_reference") WHERE "ledger_entry"."stripe_reference" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "engagement_match_request_idx" ON "engagement" USING btree ("match_request_id") WHERE "engagement"."status" <> 'cancelled';--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_stripe_checkout_session_id_unique" UNIQUE("stripe_checkout_session_id");