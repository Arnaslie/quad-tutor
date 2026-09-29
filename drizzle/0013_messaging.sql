CREATE TYPE "public"."report_outcome" AS ENUM('no_action', 'warned', 'escalated');--> statement-breakpoint
CREATE TYPE "public"."report_reason" AS ENUM('harassment', 'spam', 'safety', 'other');--> statement-breakpoint
CREATE TYPE "public"."thread_side" AS ENUM('student', 'tutor');--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"sender_side" "thread_side" NOT NULL,
	"sender_user_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_body_length" CHECK (char_length("message"."body") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "message_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"reporter_user_id" text NOT NULL,
	"reason" "report_reason" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_user_id" text,
	"outcome" "report_outcome"
);
--> statement-breakpoint
CREATE TABLE "message_thread" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_profile_id" uuid NOT NULL,
	"tutor_course_id" uuid NOT NULL,
	"student_read_through" timestamp with time zone,
	"tutor_read_through" timestamp with time zone,
	"student_alerted_at" timestamp with time zone,
	"tutor_alerted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_thread_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"operator_user_id" text NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_block" (
	"blocker_user_id" text NOT NULL,
	"blocked_user_id" text NOT NULL,
	"institution_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_block_blocker_user_id_blocked_user_id_pk" PRIMARY KEY("blocker_user_id","blocked_user_id")
);
--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_thread_id_message_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."message_thread"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_sender_user_id_user_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_report" ADD CONSTRAINT "message_report_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_report" ADD CONSTRAINT "message_report_thread_id_message_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."message_thread"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_report" ADD CONSTRAINT "message_report_reporter_user_id_user_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_report" ADD CONSTRAINT "message_report_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_thread" ADD CONSTRAINT "message_thread_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_thread" ADD CONSTRAINT "message_thread_student_profile_id_student_profile_id_fk" FOREIGN KEY ("student_profile_id") REFERENCES "public"."student_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_thread" ADD CONSTRAINT "message_thread_tutor_course_id_tutor_course_id_fk" FOREIGN KEY ("tutor_course_id") REFERENCES "public"."tutor_course"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_thread_access" ADD CONSTRAINT "message_thread_access_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_thread_access" ADD CONSTRAINT "message_thread_access_thread_id_message_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."message_thread"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_thread_access" ADD CONSTRAINT "message_thread_access_report_id_message_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."message_report"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_thread_access" ADD CONSTRAINT "message_thread_access_operator_user_id_user_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_block" ADD CONSTRAINT "user_block_blocker_user_id_user_id_fk" FOREIGN KEY ("blocker_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_block" ADD CONSTRAINT "user_block_blocked_user_id_user_id_fk" FOREIGN KEY ("blocked_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_block" ADD CONSTRAINT "user_block_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_thread_created_idx" ON "message" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "message_sender_created_idx" ON "message" USING btree ("sender_user_id","created_at");--> statement-breakpoint
CREATE INDEX "message_report_institution_idx" ON "message_report" USING btree ("institution_id","reviewed_at");--> statement-breakpoint
CREATE INDEX "message_report_thread_idx" ON "message_report" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_thread_pair_idx" ON "message_thread" USING btree ("student_profile_id","tutor_course_id");--> statement-breakpoint
CREATE INDEX "message_thread_tutor_course_idx" ON "message_thread" USING btree ("tutor_course_id");--> statement-breakpoint
CREATE INDEX "message_thread_access_thread_idx" ON "message_thread_access" USING btree ("thread_id","accessed_at");--> statement-breakpoint
CREATE INDEX "user_block_blocked_idx" ON "user_block" USING btree ("blocked_user_id");--> statement-breakpoint
INSERT INTO "message_thread" ("institution_id", "student_profile_id", "tutor_course_id")
SELECT DISTINCT "student_profile"."institution_id", "match_request"."student_profile_id", "match_request"."tutor_course_id"
FROM "match_request"
INNER JOIN "student_profile" ON "student_profile"."id" = "match_request"."student_profile_id"
ON CONFLICT DO NOTHING;
