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
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import {
  MESSAGE_MAX_LENGTH,
  REPORT_OUTCOMES,
  REPORT_REASONS,
  THREAD_SIDES,
} from "../modules/messaging/rules";

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
  "rejected",
]);

export const proofKind = pgEnum("proof_kind", ["official_transcript", "screenshot"]);

export const rejectionReason = pgEnum("rejection_reason", [
  "grade_not_visible",
  "name_mismatch",
  "wrong_course_or_term",
  "grade_below_a_minus",
  "unreadable",
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

export const threadSide = pgEnum("thread_side", THREAD_SIDES);

export const reportReason = pgEnum("report_reason", REPORT_REASONS);

export const reportOutcome = pgEnum("report_outcome", REPORT_OUTCOMES);

export const institution = pgTable("institution", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  emailDomain: text("email_domain").notNull(),
  timezone: text("timezone").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const institutionEmail = pgTable("institution_email", {
  email: text("email").primaryKey(),
  institutionId: uuid("institution_id")
    .notNull()
    .references(() => institution.id),
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
    defaultLocation: text("default_location"),

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

export const college = pgTable(
  "college",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institution.id),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [uniqueIndex("college_institution_name_idx").on(t.institutionId, t.name)],
);

export const course = pgTable(
  "course",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institution.id),
    collegeId: uuid("college_id").references(() => college.id),
    title: text("title").notNull(),
    department: text("department").notNull(),

    isSeeded: boolean("is_seeded").notNull().default(false),
  },
  (t) => [
    index("course_institution_idx").on(t.institutionId),
    index("course_college_idx").on(t.collegeId),
  ],
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

    proofKind: proofKind("proof_kind"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedByUserId: text("reviewed_by_user_id").references(() => user.id),
    rejectionReason: rejectionReason("rejection_reason"),
    decisionNotifiedAt: timestamp("decision_notified_at", { withTimezone: true }),

    scoreSampleCount: integer("score_sample_count").notNull().default(0),
    scorePosteriorMean: integer("score_posterior_mean"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tutor_course_unique_idx").on(t.tutorProfileId, t.courseId),
    index("tutor_course_course_idx").on(t.courseId),
  ],
);

export const verificationFile = pgTable(
  "verification_file",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tutorCourseId: uuid("tutor_course_id")
      .notNull()
      .references(() => tutorCourse.id),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institution.id),
    pathname: text("pathname").notNull().unique(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => [index("verification_file_claim_idx").on(t.tutorCourseId)],
);

export const operator = pgTable(
  "operator",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institution.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.institutionId] })],
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
    location: text("location"),
    studentNote: text("student_note"),
    notifiedLocation: text("notified_location"),

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
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("demand_signal_unique_idx").on(t.studentProfileId, t.courseOfferingId),
  ],
);

export const messageThread = pgTable(
  "message_thread",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institution.id),
    studentProfileId: uuid("student_profile_id")
      .notNull()
      .references(() => studentProfile.id),
    tutorCourseId: uuid("tutor_course_id")
      .notNull()
      .references(() => tutorCourse.id),

    studentReadThrough: timestamp("student_read_through", { withTimezone: true }),
    tutorReadThrough: timestamp("tutor_read_through", { withTimezone: true }),
    studentAlertedAt: timestamp("student_alerted_at", { withTimezone: true }),
    tutorAlertedAt: timestamp("tutor_alerted_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("message_thread_pair_idx").on(t.studentProfileId, t.tutorCourseId),
    index("message_thread_tutor_course_idx").on(t.tutorCourseId),
  ],
);

export const message = pgTable(
  "message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institution.id),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => messageThread.id),
    senderSide: threadSide("sender_side").notNull(),
    senderUserId: text("sender_user_id").references(() => user.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("message_thread_created_idx").on(t.threadId, t.createdAt),
    index("message_sender_created_idx").on(t.senderUserId, t.createdAt),
    check("message_body_length", sql`char_length(${t.body}) between 1 and ${sql.raw(String(MESSAGE_MAX_LENGTH))}`),
  ],
);

export const userBlock = pgTable(
  "user_block",
  {
    blockerUserId: text("blocker_user_id")
      .notNull()
      .references(() => user.id),
    blockedUserId: text("blocked_user_id")
      .notNull()
      .references(() => user.id),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institution.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.blockerUserId, t.blockedUserId] }),
    index("user_block_blocked_idx").on(t.blockedUserId),
  ],
);

export const messageReport = pgTable(
  "message_report",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institution.id),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => messageThread.id),
    reporterUserId: text("reporter_user_id")
      .notNull()
      .references(() => user.id),
    reason: reportReason("reason").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedByUserId: text("reviewed_by_user_id").references(() => user.id),
    outcome: reportOutcome("outcome"),
  },
  (t) => [
    index("message_report_institution_idx").on(t.institutionId, t.reviewedAt),
    index("message_report_thread_idx").on(t.threadId),
  ],
);

export const messageThreadAccess = pgTable(
  "message_thread_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institution.id),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => messageThread.id),
    reportId: uuid("report_id")
      .notNull()
      .references(() => messageReport.id),
    operatorUserId: text("operator_user_id")
      .notNull()
      .references(() => user.id),
    accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("message_thread_access_thread_idx").on(t.threadId, t.accessedAt)],
);
