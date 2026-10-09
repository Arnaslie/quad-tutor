CREATE TYPE "public"."money_discrepancy_kind" AS ENUM('checkout_amount', 'ledger_vs_stripe_charge', 'ledger_vs_stripe_transfers', 'unstamped_reference');--> statement-breakpoint
CREATE TABLE "money_discrepancy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"engagement_id" uuid,
	"kind" "money_discrepancy_kind" NOT NULL,
	"stripe_reference" text,
	"ledger_amount_minor" integer,
	"stripe_amount_minor" integer,
	"currency" text DEFAULT 'usd' NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"refund_reference" text,
	CONSTRAINT "money_discrepancy_refund_reference_unique" UNIQUE("refund_reference")
);
--> statement-breakpoint
ALTER TABLE "money_discrepancy" ADD CONSTRAINT "money_discrepancy_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_discrepancy" ADD CONSTRAINT "money_discrepancy_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "money_discrepancy_institution_idx" ON "money_discrepancy" USING btree ("institution_id","resolved_at");--> statement-breakpoint
CREATE INDEX "money_discrepancy_engagement_idx" ON "money_discrepancy" USING btree ("engagement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "money_discrepancy_kind_reference_idx" ON "money_discrepancy" USING btree ("kind","stripe_reference") WHERE "money_discrepancy"."stripe_reference" is not null;