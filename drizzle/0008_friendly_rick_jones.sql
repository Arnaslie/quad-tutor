CREATE TABLE "institution_email" (
	"email" text PRIMARY KEY NOT NULL,
	"institution_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "institution_email" ADD CONSTRAINT "institution_email_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;