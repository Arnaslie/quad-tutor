CREATE TABLE "college" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "course" ADD COLUMN "college_id" uuid;--> statement-breakpoint
ALTER TABLE "college" ADD CONSTRAINT "college_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "college_institution_name_idx" ON "college" USING btree ("institution_id","name");--> statement-breakpoint
ALTER TABLE "course" ADD CONSTRAINT "course_college_id_college_id_fk" FOREIGN KEY ("college_id") REFERENCES "public"."college"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "course_college_idx" ON "course" USING btree ("college_id");