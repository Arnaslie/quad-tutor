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
UPDATE "reliability_event" t SET "institution_id" = coalesce(s."institution_id", p."institution_id") FROM "user" u LEFT JOIN "student_profile" s ON s."user_id" = u."id" LEFT JOIN "tutor_profile" p ON p."user_id" = u."id" WHERE u."id" = t."user_id" AND t."institution_id" IS NULL;--> statement-breakpoint
ALTER TABLE "course_code_alias" ALTER COLUMN "institution_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "course_offering" ALTER COLUMN "institution_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "demand_signal" ALTER COLUMN "institution_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "engagement" ALTER COLUMN "institution_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "enrollment" ALTER COLUMN "institution_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "exam" ALTER COLUMN "institution_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_entry" ALTER COLUMN "institution_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "match_request" ALTER COLUMN "institution_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "reliability_event" ALTER COLUMN "institution_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "session_booking" ALTER COLUMN "institution_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tutor_availability" ALTER COLUMN "institution_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tutor_course" ALTER COLUMN "institution_id" SET NOT NULL;