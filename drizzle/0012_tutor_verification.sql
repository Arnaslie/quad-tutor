CREATE TYPE "public"."proof_kind" AS ENUM('official_transcript', 'screenshot');--> statement-breakpoint
CREATE TYPE "public"."rejection_reason" AS ENUM('grade_not_visible', 'name_mismatch', 'wrong_course_or_term', 'grade_below_a_minus', 'unreadable');--> statement-breakpoint
ALTER TYPE "public"."tutor_course_status" ADD VALUE 'rejected';--> statement-breakpoint
CREATE TABLE "operator" (
	"user_id" text NOT NULL,
	"institution_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_user_id_institution_id_pk" PRIMARY KEY("user_id","institution_id")
);
--> statement-breakpoint
CREATE TABLE "verification_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tutor_course_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"pathname" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "verification_file_pathname_unique" UNIQUE("pathname")
);
--> statement-breakpoint
ALTER TABLE "tutor_course" ADD COLUMN "proof_kind" "proof_kind";--> statement-breakpoint
ALTER TABLE "tutor_course" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tutor_course" ADD COLUMN "reviewed_by_user_id" text;--> statement-breakpoint
ALTER TABLE "tutor_course" ADD COLUMN "rejection_reason" "rejection_reason";--> statement-breakpoint
ALTER TABLE "tutor_course" ADD COLUMN "decision_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operator" ADD CONSTRAINT "operator_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator" ADD CONSTRAINT "operator_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_file" ADD CONSTRAINT "verification_file_tutor_course_id_tutor_course_id_fk" FOREIGN KEY ("tutor_course_id") REFERENCES "public"."tutor_course"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_file" ADD CONSTRAINT "verification_file_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verification_file_claim_idx" ON "verification_file" USING btree ("tutor_course_id");--> statement-breakpoint
ALTER TABLE "tutor_course" ADD CONSTRAINT "tutor_course_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;