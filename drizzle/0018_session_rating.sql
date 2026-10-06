ALTER TYPE "public"."report_outcome" ADD VALUE 'removed';--> statement-breakpoint
CREATE TABLE "session_rating" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"tutor_course_id" uuid NOT NULL,
	"student_profile_id" uuid NOT NULL,
	"stars" smallint NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_user_id" text,
	"released_at" timestamp with time zone,
	CONSTRAINT "session_rating_stars" CHECK ("session_rating"."stars" between 1 and 5),
	CONSTRAINT "session_rating_note_length" CHECK (char_length("session_rating"."note") <= 280)
);
--> statement-breakpoint
ALTER TABLE "message_report" ALTER COLUMN "thread_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_report" ADD COLUMN "session_rating_id" uuid;--> statement-breakpoint
ALTER TABLE "session_rating" ADD CONSTRAINT "session_rating_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_rating" ADD CONSTRAINT "session_rating_session_id_session_booking_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session_booking"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_rating" ADD CONSTRAINT "session_rating_tutor_course_id_tutor_course_id_fk" FOREIGN KEY ("tutor_course_id") REFERENCES "public"."tutor_course"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_rating" ADD CONSTRAINT "session_rating_student_profile_id_student_profile_id_fk" FOREIGN KEY ("student_profile_id") REFERENCES "public"."student_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_rating" ADD CONSTRAINT "session_rating_removed_by_user_id_user_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_rating_session_idx" ON "session_rating" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_rating_tutor_course_idx" ON "session_rating" USING btree ("institution_id","tutor_course_id") WHERE "session_rating"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "session_rating_student_idx" ON "session_rating" USING btree ("student_profile_id");--> statement-breakpoint
ALTER TABLE "message_report" ADD CONSTRAINT "message_report_session_rating_id_session_rating_id_fk" FOREIGN KEY ("session_rating_id") REFERENCES "public"."session_rating"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entry_session_earned_idx" ON "ledger_entry" USING btree ("session_id") WHERE "ledger_entry"."type" = 'session_earned';--> statement-breakpoint
CREATE UNIQUE INDEX "message_report_open_rating_idx" ON "message_report" USING btree ("session_rating_id") WHERE "message_report"."reviewed_at" is null;--> statement-breakpoint
ALTER TABLE "message_report" ADD CONSTRAINT "message_report_subject" CHECK (num_nonnulls("message_report"."thread_id", "message_report"."session_rating_id") = 1);