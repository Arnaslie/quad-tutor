CREATE TYPE "public"."attendance_resolution" AS ENUM('both_confirmed', 'auto_released', 'disputed', 'resolved_attended', 'resolved_not_attended');--> statement-breakpoint
CREATE TYPE "public"."engagement_status" AS ENUM('active', 'completed', 'refunded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."kyc_status" AS ENUM('not_started', 'pending', 'verified', 'restricted');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('package_purchase', 'session_earned', 'tutor_payout', 'platform_fee', 'refund', 'guarantee_absorbed');--> statement-breakpoint
CREATE TYPE "public"."match_request_status" AS ENUM('pending', 'accepted', 'declined', 'expired', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."package_kind" AS ENUM('exam_anchored', 'through_final');--> statement-breakpoint
CREATE TYPE "public"."reliability_event_type" AS ENUM('attended', 'late_cancelled', 'no_showed', 'payment_failed');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('scheduled', 'completed', 'cancelled', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."tutor_course_status" AS ENUM('pending_verification', 'active', 'winding_down', 'retired');--> statement-breakpoint
CREATE TABLE "course" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"title" text NOT NULL,
	"department" text NOT NULL,
	"is_seeded" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_code_alias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"code" text NOT NULL,
	"valid_from_term_id" uuid,
	"valid_to_term_id" uuid
);
--> statement-breakpoint
CREATE TABLE "course_offering" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"professor_id" uuid,
	"section" text
);
--> statement-breakpoint
CREATE TABLE "engagement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_profile_id" uuid NOT NULL,
	"tutor_course_id" uuid NOT NULL,
	"course_offering_id" uuid NOT NULL,
	"kind" "package_kind" DEFAULT 'exam_anchored' NOT NULL,
	"anchor_exam_id" uuid,
	"sessions_purchased" integer NOT NULL,
	"price_paid_minor" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"guarantee_used" boolean DEFAULT false NOT NULL,
	"status" "engagement_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "enrollment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_profile_id" uuid NOT NULL,
	"course_offering_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exam" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_offering_id" uuid NOT NULL,
	"name" text NOT NULL,
	"occurs_on" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "institution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"email_domain" text NOT NULL,
	"timezone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "institution_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "ledger_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"session_id" uuid,
	"type" "ledger_entry_type" NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"stripe_reference" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_profile_id" uuid NOT NULL,
	"tutor_course_id" uuid NOT NULL,
	"course_offering_id" uuid NOT NULL,
	"status" "match_request_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "professor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"department" text
);
--> statement-breakpoint
CREATE TABLE "reliability_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"session_id" uuid,
	"type" "reliability_event_type" NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_booking" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer DEFAULT 60 NOT NULL,
	"location_note" text,
	"status" "session_status" DEFAULT 'scheduled' NOT NULL,
	"student_confirmed_at" timestamp with time zone,
	"tutor_confirmed_at" timestamp with time zone,
	"confirmation_window_ends_at" timestamp with time zone,
	"resolution" "attendance_resolution",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"institution_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "term" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutor_course" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tutor_profile_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"grade_earned" text NOT NULL,
	"taken_term_id" uuid NOT NULL,
	"taken_under_professor_id" uuid,
	"verified_at" timestamp with time zone,
	"status" "tutor_course_status" DEFAULT 'pending_verification' NOT NULL,
	"score_sample_count" integer DEFAULT 0 NOT NULL,
	"score_posterior_mean" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutor_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"institution_id" uuid NOT NULL,
	"headline" text,
	"bio" text,
	"stripe_account_id" text,
	"kyc_status" "kyc_status" DEFAULT 'not_started' NOT NULL,
	"expected_graduation_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"institution_id" uuid NOT NULL,
	"edu_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "course" ADD CONSTRAINT "course_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_code_alias" ADD CONSTRAINT "course_code_alias_course_id_course_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."course"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_code_alias" ADD CONSTRAINT "course_code_alias_valid_from_term_id_term_id_fk" FOREIGN KEY ("valid_from_term_id") REFERENCES "public"."term"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_code_alias" ADD CONSTRAINT "course_code_alias_valid_to_term_id_term_id_fk" FOREIGN KEY ("valid_to_term_id") REFERENCES "public"."term"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_offering" ADD CONSTRAINT "course_offering_course_id_course_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."course"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_offering" ADD CONSTRAINT "course_offering_term_id_term_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."term"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_offering" ADD CONSTRAINT "course_offering_professor_id_professor_id_fk" FOREIGN KEY ("professor_id") REFERENCES "public"."professor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_student_profile_id_student_profile_id_fk" FOREIGN KEY ("student_profile_id") REFERENCES "public"."student_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_tutor_course_id_tutor_course_id_fk" FOREIGN KEY ("tutor_course_id") REFERENCES "public"."tutor_course"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_course_offering_id_course_offering_id_fk" FOREIGN KEY ("course_offering_id") REFERENCES "public"."course_offering"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_anchor_exam_id_exam_id_fk" FOREIGN KEY ("anchor_exam_id") REFERENCES "public"."exam"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_student_profile_id_student_profile_id_fk" FOREIGN KEY ("student_profile_id") REFERENCES "public"."student_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_course_offering_id_course_offering_id_fk" FOREIGN KEY ("course_offering_id") REFERENCES "public"."course_offering"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam" ADD CONSTRAINT "exam_course_offering_id_course_offering_id_fk" FOREIGN KEY ("course_offering_id") REFERENCES "public"."course_offering"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_session_id_session_booking_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session_booking"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_request" ADD CONSTRAINT "match_request_student_profile_id_student_profile_id_fk" FOREIGN KEY ("student_profile_id") REFERENCES "public"."student_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_request" ADD CONSTRAINT "match_request_tutor_course_id_tutor_course_id_fk" FOREIGN KEY ("tutor_course_id") REFERENCES "public"."tutor_course"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_request" ADD CONSTRAINT "match_request_course_offering_id_course_offering_id_fk" FOREIGN KEY ("course_offering_id") REFERENCES "public"."course_offering"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professor" ADD CONSTRAINT "professor_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reliability_event" ADD CONSTRAINT "reliability_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reliability_event" ADD CONSTRAINT "reliability_event_session_id_session_booking_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session_booking"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_booking" ADD CONSTRAINT "session_booking_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_profile" ADD CONSTRAINT "student_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_profile" ADD CONSTRAINT "student_profile_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term" ADD CONSTRAINT "term_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_course" ADD CONSTRAINT "tutor_course_tutor_profile_id_tutor_profile_id_fk" FOREIGN KEY ("tutor_profile_id") REFERENCES "public"."tutor_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_course" ADD CONSTRAINT "tutor_course_course_id_course_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."course"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_course" ADD CONSTRAINT "tutor_course_taken_term_id_term_id_fk" FOREIGN KEY ("taken_term_id") REFERENCES "public"."term"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_course" ADD CONSTRAINT "tutor_course_taken_under_professor_id_professor_id_fk" FOREIGN KEY ("taken_under_professor_id") REFERENCES "public"."professor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_profile" ADD CONSTRAINT "tutor_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_profile" ADD CONSTRAINT "tutor_profile_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "course_institution_idx" ON "course" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "course_code_alias_code_idx" ON "course_code_alias" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "course_offering_unique_idx" ON "course_offering" USING btree ("course_id","term_id","section");--> statement-breakpoint
CREATE INDEX "course_offering_course_idx" ON "course_offering" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX "engagement_student_idx" ON "engagement" USING btree ("student_profile_id","status");--> statement-breakpoint
CREATE INDEX "engagement_tutor_course_idx" ON "engagement" USING btree ("tutor_course_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enrollment_unique_idx" ON "enrollment" USING btree ("student_profile_id","course_offering_id");--> statement-breakpoint
CREATE INDEX "exam_offering_idx" ON "exam" USING btree ("course_offering_id");--> statement-breakpoint
CREATE INDEX "ledger_entry_engagement_idx" ON "ledger_entry" USING btree ("engagement_id","occurred_at");--> statement-breakpoint
CREATE INDEX "match_request_student_idx" ON "match_request" USING btree ("student_profile_id","status");--> statement-breakpoint
CREATE INDEX "match_request_tutor_course_idx" ON "match_request" USING btree ("tutor_course_id","status");--> statement-breakpoint
CREATE INDEX "professor_institution_idx" ON "professor" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "reliability_event_user_idx" ON "reliability_event" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "session_engagement_idx" ON "session_booking" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "session_scheduled_idx" ON "session_booking" USING btree ("scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "student_profile_user_idx" ON "student_profile" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "term_institution_name_idx" ON "term" USING btree ("institution_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "tutor_course_unique_idx" ON "tutor_course" USING btree ("tutor_profile_id","course_id");--> statement-breakpoint
CREATE INDEX "tutor_course_course_idx" ON "tutor_course" USING btree ("course_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tutor_profile_user_idx" ON "tutor_profile" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_institution_idx" ON "user" USING btree ("institution_id");