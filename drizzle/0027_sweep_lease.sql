CREATE TABLE "sweep_lease" (
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"held_until" timestamp with time zone NOT NULL,
	CONSTRAINT "sweep_lease_institution_id_name_pk" PRIMARY KEY("institution_id","name")
);
--> statement-breakpoint
ALTER TABLE "sweep_lease" ADD CONSTRAINT "sweep_lease_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;