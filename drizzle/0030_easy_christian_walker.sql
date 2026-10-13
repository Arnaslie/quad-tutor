ALTER TYPE "public"."money_discrepancy_kind" ADD VALUE 'orphaned_account';--> statement-breakpoint
ALTER TABLE "engagement" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD COLUMN "corrects_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD COLUMN "recorded_by_user_id" text;--> statement-breakpoint
ALTER TABLE "money_discrepancy" ADD COLUMN "resolved_by_user_id" text;--> statement-breakpoint
ALTER TABLE "payment_dispute" ADD COLUMN "resolved_by_user_id" text;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_corrects_entry_id_ledger_entry_id_fk" FOREIGN KEY ("corrects_entry_id") REFERENCES "public"."ledger_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_discrepancy" ADD CONSTRAINT "money_discrepancy_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dispute" ADD CONSTRAINT "payment_dispute_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entry_corrects_entry_idx" ON "ledger_entry" USING btree ("corrects_entry_id") WHERE "ledger_entry"."corrects_entry_id" is not null;