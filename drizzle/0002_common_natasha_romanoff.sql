CREATE TABLE "demand_signal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_profile_id" uuid NOT NULL,
	"course_offering_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutor_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tutor_profile_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demand_signal" ADD CONSTRAINT "demand_signal_student_profile_id_student_profile_id_fk" FOREIGN KEY ("student_profile_id") REFERENCES "public"."student_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_signal" ADD CONSTRAINT "demand_signal_course_offering_id_course_offering_id_fk" FOREIGN KEY ("course_offering_id") REFERENCES "public"."course_offering"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_availability" ADD CONSTRAINT "tutor_availability_tutor_profile_id_tutor_profile_id_fk" FOREIGN KEY ("tutor_profile_id") REFERENCES "public"."tutor_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "demand_signal_unique_idx" ON "demand_signal" USING btree ("student_profile_id","course_offering_id");--> statement-breakpoint
CREATE INDEX "tutor_availability_tutor_idx" ON "tutor_availability" USING btree ("tutor_profile_id");