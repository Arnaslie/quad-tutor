import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { user, session, account, verification } from "./auth-schema";

export const kycStatus = pgEnum("kyc_status", [
  "not_started",
  "pending",
  "verified",
  "restricted",
]);

export const tutorCourseStatus = pgEnum("tutor_course_status", [
  "pending_verification",
  "active",
  "winding_down",
  "retired",
]);

export const matchRequestStatus = pgEnum("match_request_status", [
  "pending",
  "accepted",
  "declined",
  "expired",
  "withdrawn",
]);

export const engagementStatus = pgEnum("engagement_status", [
  "active",
  "completed",
  "refunded",
  "cancelled",
]);

export const sessionStatus = pgEnum("session_status", [
  "scheduled",
  "completed",
  "cancelled",
  "disputed",
]);

export const attendanceResolution = pgEnum("attendance_resolution", [
  "both_confirmed",
  "auto_released",
  "disputed",
  "resolved_attended",
  "resolved_not_attended",
]);

export const reliabilityEventType = pgEnum("reliability_event_type", [
  "attended",
  "late_cancelled",
  "no_showed",
  "payment_failed",
]);

export const ledgerEntryType = pgEnum("ledger_entry_type", [
  "package_purchase",
  "session_earned",
  "tutor_payout",
  "platform_fee",
  "refund",
  "guarantee_absorbed",
]);

export const packageKind = pgEnum("package_kind", [
  "exam_anchored",
  "through_final",

  "top_up",
]);

export const institution = pgTable("institution", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  emailDomain: text("email_domain").notNull(),
  timezone: text("timezone").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export { user, session, account, verification };

export const studentProfile = pgTable(
  "student_profile",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institution.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("student_profile_user_idx").on(t.userId)],
);

export const tutorProfile = pgTable(
  "tutor_profile",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institution.id),

    headline: text("headline"),
    bio: text("bio"),

    stripeAccountId: text("stripe_account_id"),
    kycStatus: kycStatus("kyc_status").notNull().default("not_started"),

    expectedGraduationOn: date("expected_graduation_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tutor_profile_user_idx").on(t.userId)],
);

export const term = pgTable(
  "term",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institution.id),
    name: text("name").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
  },
  (t) => [uniqueIndex("term_institution_name_idx").on(t.institutionId, t.name)],
);

export const professor = pgTable(
  "professor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institution.id),
    name: text("name").notNull(),
    department: text("department"),
  },
  (t) => [index("professor_institution_idx").on(t.institutionId)],
);

export const course = pgTable(
  "course",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institution.id),
    title: text("title").notNull(),
    department: text("department").notNull(),

    isSeeded: boolean("is_seeded").notNull().default(false),
  },
  (t) => [index("course_institution_idx").on(t.institutionId)],
);

export const courseCodeAlias = pgTable(
  "course_code_alias",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => course.id),
    code: text("code").notNull(),
    validFromTermId: uuid("valid_from_term_id").references(() => term.id),
    validToTermId: uuid("valid_to_term_id").references(() => term.id),
  },
  (t) => [index("course_code_alias_code_idx").on(t.code)],
);

export const courseOffering = pgTable(
  "course_offering",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => course.id),
    termId: uuid("term_id")
      .notNull()
      .references(() => term.id),
    professorId: uuid("professor_id").references(() => professor.id),
    section: text("section"),
  },
  (t) => [
    uniqueIndex("course_offering_unique_idx").on(t.courseId, t.termId, t.section),
    index("course_offering_course_idx").on(t.courseId),
  ],
);

export const exam = pgTable(
  "exam",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseOfferingId: uuid("course_offering_id")
      .notNull()
      .references(() => courseOffering.id),
    name: text("name").notNull(),
    occursOn: date("occurs_on").notNull(),
  },
  (t) => [index("exam_offering_idx").on(t.courseOfferingId)],
);

export const enrollment = pgTable(
  "enrollment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentProfileId: uuid("student_profile_id")
      .notNull()
      .references(() => studentProfile.id),
    courseOfferingId: uuid("course_offering_id")
      .notNull()
      .references(() => courseOffering.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("enrollment_unique_idx").on(t.studentProfileId, t.courseOfferingId),
  ],
);

export const tutorCourse = pgTable(
  "tutor_course",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tutorProfileId: uuid("tutor_profile_id")
      .notNull()
      .references(() => tutorProfile.id),

    courseId: uuid("course_id")
      .notNull()
      .references(() => course.id),

    gradeEarned: text("grade_earned").notNull(),
    takenTermId: uuid("taken_term_id")
      .notNull()
      .references(() => term.id),
    takenUnderProfessorId: uuid("taken_under_professor_id").references(
      () => professor.id,
    ),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    status: tutorCourseStatus("status").notNull().default("pending_verification"),

    scoreSampleCount: integer("score_sample_count").notNull().default(0),
    scorePosteriorMean: integer("score_posterior_mean"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tutor_course_unique_idx").on(t.tutorProfileId, t.courseId),
    index("tutor_course_course_idx").on(t.courseId),
  ],
);

export const matchRequest = pgTable(
  "match_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentProfileId: uuid("student_profile_id")
      .notNull()
      .references(() => studentProfile.id),
    tutorCourseId: uuid("tutor_course_id")
      .notNull()
      .references(() => tutorCourse.id),
    courseOfferingId: uuid("course_offering_id")
      .notNull()
      .references(() => courseOffering.id),

    status: matchRequestStatus("status").notNull().default("pending"),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    tutorNotifiedAt: timestamp("tutor_notified_at", { withTimezone: true }),
    studentNotifiedAt: timestamp("student_notified_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("match_request_student_idx").on(t.studentProfileId, t.status),
    index("match_request_tutor_course_idx").on(t.tutorCourseId, t.status),
  ],
);

export const engagement = pgTable(
  "engagement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentProfileId: uuid("student_profile_id")
      .notNull()
      .references(() => studentProfile.id),
    tutorCourseId: uuid("tutor_course_id")
      .notNull()
      .references(() => tutorCourse.id),
    courseOfferingId: uuid("course_offering_id")
      .notNull()
      .references(() => courseOffering.id),

    matchRequestId: uuid("match_request_id").references(() => matchRequest.id),

    kind: packageKind("kind").notNull().default("exam_anchored"),
    anchorExamId: uuid("anchor_exam_id").references(() => exam.id),

    sessionsPurchased: integer("sessions_purchased").notNull(),
    pricePaidMinor: integer("price_paid_minor").notNull(),
    currency: text("currency").notNull().default("usd"),

    guaranteeUsed: boolean("guarantee_used").notNull().default(false),

    status: engagementStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("engagement_match_request_idx").on(t.matchRequestId),
    index("engagement_student_idx").on(t.studentProfileId, t.status),
    index("engagement_tutor_course_idx").on(t.tutorCourseId),
  ],
);

export const sessionBooking = pgTable(
  "session_booking",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagement.id),

    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    durationMinutes: integer("duration_minutes").notNull().default(60),

    locationNote: text("location_note"),

    status: sessionStatus("status").notNull().default("scheduled"),

    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledByUserId: text("cancelled_by_user_id").references(() => user.id),

    studentConfirmedAt: timestamp("student_confirmed_at", { withTimezone: true }),
    tutorConfirmedAt: timestamp("tutor_confirmed_at", { withTimezone: true }),

    studentDeniedAt: timestamp("student_denied_at", { withTimezone: true }),
    tutorDeniedAt: timestamp("tutor_denied_at", { withTimezone: true }),

    denialNote: text("denial_note"),

    bookedNotifiedAt: timestamp("booked_notified_at", { withTimezone: true }),
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    confirmationWindowEndsAt: timestamp("confirmation_window_ends_at", {
      withTimezone: true,
    }),
    resolution: attendanceResolution("resolution"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("session_engagement_idx").on(t.engagementId),
    index("session_scheduled_idx").on(t.scheduledAt),
  ],
);

export const reliabilityEvent = pgTable(
  "reliability_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    sessionId: uuid("session_id").references(() => sessionBooking.id),
    type: reliabilityEventType("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reliability_event_user_idx").on(t.userId, t.occurredAt)],
);

export const ledgerEntry = pgTable(
  "ledger_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagement.id),
    sessionId: uuid("session_id").references(() => sessionBooking.id),

    type: ledgerEntryType("type").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull().default("usd"),

    stripeReference: text("stripe_reference"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ledger_entry_engagement_idx").on(t.engagementId, t.occurredAt)],
);

export const tutorAvailability = pgTable(
  "tutor_availability",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tutorProfileId: uuid("tutor_profile_id")
      .notNull()
      .references(() => tutorProfile.id),

    weekday: integer("weekday").notNull(),
    startMinute: integer("start_minute").notNull(),
    endMinute: integer("end_minute").notNull(),
  },
  (t) => [index("tutor_availability_tutor_idx").on(t.tutorProfileId)],
);

export const demandSignal = pgTable(
  "demand_signal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentProfileId: uuid("student_profile_id")
      .notNull()
      .references(() => studentProfile.id),
    courseOfferingId: uuid("course_offering_id")
      .notNull()
      .references(() => courseOffering.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("demand_signal_unique_idx").on(t.studentProfileId, t.courseOfferingId),
  ],
);
