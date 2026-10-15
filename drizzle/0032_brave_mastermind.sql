ALTER TABLE "match_request" ADD COLUMN "quoted_rate_minor" integer;--> statement-breakpoint
ALTER TABLE "tutor_course" ADD COLUMN "session_rate_minor" integer DEFAULT 3500 NOT NULL;