CREATE TABLE "session_rating_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"session_rating_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"operator_user_id" text NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_rating_access" ADD CONSTRAINT "session_rating_access_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_rating_access" ADD CONSTRAINT "session_rating_access_session_rating_id_session_rating_id_fk" FOREIGN KEY ("session_rating_id") REFERENCES "public"."session_rating"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_rating_access" ADD CONSTRAINT "session_rating_access_report_id_message_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."message_report"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_rating_access" ADD CONSTRAINT "session_rating_access_operator_user_id_user_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_rating_access_rating_idx" ON "session_rating_access" USING btree ("session_rating_id","accessed_at");