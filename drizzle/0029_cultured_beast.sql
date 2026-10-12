CREATE TABLE "payment_dispute" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"stripe_dispute_id" text NOT NULL,
	"payment_intent_id" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"reason" text,
	"status" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_dispute_stripe_dispute_id_unique" UNIQUE("stripe_dispute_id")
);
--> statement-breakpoint
ALTER TABLE "payment_dispute" ADD CONSTRAINT "payment_dispute_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dispute" ADD CONSTRAINT "payment_dispute_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_dispute_institution_idx" ON "payment_dispute" USING btree ("institution_id","resolved_at");--> statement-breakpoint
CREATE INDEX "payment_dispute_engagement_idx" ON "payment_dispute" USING btree ("engagement_id");