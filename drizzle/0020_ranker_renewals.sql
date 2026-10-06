ALTER TABLE "tutor_course" ADD COLUMN "renewal_trial_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tutor_course" ADD COLUMN "renewal_posterior_mean" integer;