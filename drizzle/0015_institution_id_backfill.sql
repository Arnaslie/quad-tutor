ALTER TABLE "course_code_alias" ADD COLUMN "institution_id" uuid;--> statement-breakpoint
ALTER TABLE "course_offering" ADD COLUMN "institution_id" uuid;--> statement-breakpoint
ALTER TABLE "demand_signal" ADD COLUMN "institution_id" uuid;--> statement-breakpoint
ALTER TABLE "engagement" ADD COLUMN "institution_id" uuid;--> statement-breakpoint
ALTER TABLE "enrollment" ADD COLUMN "institution_id" uuid;--> statement-breakpoint
ALTER TABLE "exam" ADD COLUMN "institution_id" uuid;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD COLUMN "institution_id" uuid;--> statement-breakpoint
ALTER TABLE "match_request" ADD COLUMN "institution_id" uuid;--> statement-breakpoint
ALTER TABLE "reliability_event" ADD COLUMN "institution_id" uuid;--> statement-breakpoint
ALTER TABLE "session_booking" ADD COLUMN "institution_id" uuid;--> statement-breakpoint
ALTER TABLE "tutor_availability" ADD COLUMN "institution_id" uuid;--> statement-breakpoint
ALTER TABLE "tutor_course" ADD COLUMN "institution_id" uuid;--> statement-breakpoint
ALTER TABLE "course_code_alias" ADD CONSTRAINT "course_code_alias_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_offering" ADD CONSTRAINT "course_offering_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_signal" ADD CONSTRAINT "demand_signal_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam" ADD CONSTRAINT "exam_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_request" ADD CONSTRAINT "match_request_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reliability_event" ADD CONSTRAINT "reliability_event_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_booking" ADD CONSTRAINT "session_booking_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_availability" ADD CONSTRAINT "tutor_availability_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_course" ADD CONSTRAINT "tutor_course_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "demand_signal_institution_idx" ON "demand_signal" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "engagement_institution_idx" ON "engagement" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "match_request_institution_idx" ON "match_request" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "session_booking_institution_idx" ON "session_booking" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "tutor_course_institution_idx" ON "tutor_course" USING btree ("institution_id");--> statement-breakpoint
UPDATE "course_offering" t SET "institution_id" = c."institution_id" FROM "course" c WHERE c."id" = t."course_id" AND t."institution_id" IS NULL;--> statement-breakpoint
UPDATE "course_code_alias" t SET "institution_id" = c."institution_id" FROM "course" c WHERE c."id" = t."course_id" AND t."institution_id" IS NULL;--> statement-breakpoint
UPDATE "exam" t SET "institution_id" = c."institution_id" FROM "course_offering" o JOIN "course" c ON c."id" = o."course_id" WHERE o."id" = t."course_offering_id" AND t."institution_id" IS NULL;--> statement-breakpoint
UPDATE "enrollment" t SET "institution_id" = s."institution_id" FROM "student_profile" s WHERE s."id" = t."student_profile_id" AND t."institution_id" IS NULL;--> statement-breakpoint
UPDATE "demand_signal" t SET "institution_id" = s."institution_id" FROM "student_profile" s WHERE s."id" = t."student_profile_id" AND t."institution_id" IS NULL;--> statement-breakpoint
UPDATE "tutor_course" t SET "institution_id" = p."institution_id" FROM "tutor_profile" p WHERE p."id" = t."tutor_profile_id" AND t."institution_id" IS NULL;--> statement-breakpoint
UPDATE "tutor_availability" t SET "institution_id" = p."institution_id" FROM "tutor_profile" p WHERE p."id" = t."tutor_profile_id" AND t."institution_id" IS NULL;--> statement-breakpoint
UPDATE "match_request" t SET "institution_id" = s."institution_id" FROM "student_profile" s WHERE s."id" = t."student_profile_id" AND t."institution_id" IS NULL;--> statement-breakpoint
UPDATE "engagement" t SET "institution_id" = s."institution_id" FROM "student_profile" s WHERE s."id" = t."student_profile_id" AND t."institution_id" IS NULL;--> statement-breakpoint
UPDATE "session_booking" t SET "institution_id" = s."institution_id" FROM "engagement" e JOIN "student_profile" s ON s."id" = e."student_profile_id" WHERE e."id" = t."engagement_id" AND t."institution_id" IS NULL;--> statement-breakpoint
UPDATE "ledger_entry" t SET "institution_id" = s."institution_id" FROM "engagement" e JOIN "student_profile" s ON s."id" = e."student_profile_id" WHERE e."id" = t."engagement_id" AND t."institution_id" IS NULL;--> statement-breakpoint
UPDATE "reliability_event" t SET "institution_id" = s."institution_id" FROM "session_booking" b JOIN "engagement" e ON e."id" = b."engagement_id" JOIN "student_profile" s ON s."id" = e."student_profile_id" WHERE b."id" = t."session_id" AND t."institution_id" IS NULL;--> statement-breakpoint
UPDATE "reliability_event" t SET "institution_id" = coalesce(s."institution_id", p."institution_id") FROM "user" u LEFT JOIN "student_profile" s ON s."user_id" = u."id" LEFT JOIN "tutor_profile" p ON p."user_id" = u."id" WHERE u."id" = t."user_id" AND t."institution_id" IS NULL;