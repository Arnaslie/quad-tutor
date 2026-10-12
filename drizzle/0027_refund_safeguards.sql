CREATE TABLE "sweep_lease" (
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"held_until" timestamp with time zone NOT NULL,
	CONSTRAINT "sweep_lease_institution_id_name_pk" PRIMARY KEY("institution_id","name")
);
--> statement-breakpoint
ALTER TABLE "money_discrepancy" ADD COLUMN "ledger_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "sweep_lease" ADD CONSTRAINT "sweep_lease_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_discrepancy" ADD CONSTRAINT "money_discrepancy_ledger_entry_id_ledger_entry_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "money_discrepancy_ledger_entry_idx" ON "money_discrepancy" USING btree ("ledger_entry_id");