import {
  and,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  not,
  sql,
  type Column,
  type SQL,
} from "drizzle-orm";

import { db } from "@/server/db";
import {
  course,
  courseCodeAlias,
  courseOffering,
  demandSignal,
  engagement,
  matchRequest,
  sessionBooking,
  studentProfile,
  term,
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";
import { tutorUser } from "@/server/modules/engagements/access";
import { deliveredIfUnanswered } from "@/server/modules/engagements/answer-outcome";
import { LATE_CANCEL_HOURS, reminderDueAt } from "@/server/modules/engagements/attendance";
import { displayName } from "@/server/modules/identity/display-name";
import { notifyUnreadMessages } from "@/server/modules/messaging/alerts";
import { blockedBetween } from "@/server/modules/messaging/blocks";
import { REJECTION_REASON_COPY } from "@/server/modules/tutoring/proof-rules";

import { EmailError, sendEmail, type Email } from "./email";
import {
  answerDue,
  claimNeedsNewProof,
  claimVerified,
  requestAccepted,
  requestWaiting,
  sectionCovered,
  sessionBooked,
  sessionCancelled,
  sessionMoved,
  sessionSettled,
  sessionTomorrow,
} from "./messages";

function freeUntil(scheduledAt: Date): Date {
  return new Date(scheduledAt.getTime() - LATE_CANCEL_HOURS * 60 * 60 * 1000);
}

const sessionParties = {
  sessionId: sessionBooking.id,
  scheduledAt: sessionBooking.scheduledAt,
  location: sessionBooking.location,
  studentNote: sessionBooking.studentNote,
  notifiedLocation: sessionBooking.notifiedLocation,
  cancelledByUserId: sessionBooking.cancelledByUserId,
  bookedNotifiedAt: sessionBooking.bookedNotifiedAt,
  confirmationWindowEndsAt: sessionBooking.confirmationWindowEndsAt,
  resolution: sessionBooking.resolution,
  studentConfirmedAt: sessionBooking.studentConfirmedAt,
  studentDeniedAt: sessionBooking.studentDeniedAt,
  tutorConfirmedAt: sessionBooking.tutorConfirmedAt,
  tutorDeniedAt: sessionBooking.tutorDeniedAt,
  studentUserId: user.id,
  studentEmail: user.email,
  studentName: user.name,
  tutorEmail: tutorUser.email,
  tutorName: tutorUser.name,
  code: courseCodeAlias.code,
  title: course.title,
};

type SessionRow = Awaited<ReturnType<typeof sessionQuery>>[number];

type Side = "student" | "tutor";

const SIDES: Side[] = ["student", "tutor"];

function campus(institutionId: string) {
  return and(
    eq(tutorProfile.institutionId, institutionId),
    eq(studentProfile.institutionId, institutionId),
  );
}

function addressed(row: SessionRow, side: Side) {
  const student = displayName(row.studentName, "student");
  const tutor = displayName(row.tutorName, "tutor");
  return {
    to: side === "student" ? row.studentEmail : row.tutorEmail,
    name: side === "student" ? student : tutor,
    otherPartyName: side === "student" ? tutor : student,
    recipient: side,
    courseLabel: row.code ?? row.title,
    scheduledAt: row.scheduledAt,
    sessionId: row.sessionId,
  };
}

type Marker = "bookedNotifiedAt" | "cancelNotifiedAt" | "answerPromptedAt" | "settledNotifiedAt";

async function claimAndSend(params: {
  sessionId: string;
  marker: Marker;
  unchanged: SQL | undefined;
  also?: Partial<typeof sessionBooking.$inferInsert>;
  emails: Email[];
}): Promise<number> {
  const column = sessionBooking[params.marker];
  const claimedAt = new Date();
  const claimed = await db
    .update(sessionBooking)
    .set({ ...params.also, [params.marker]: claimedAt })
    .where(and(eq(sessionBooking.id, params.sessionId), isNull(column), params.unchanged))
    .returning({ id: sessionBooking.id });
  if (claimed.length === 0) return 0;

  let sent = 0;
  for (const email of params.emails) {
    try {
      await sendEmail(email);
      sent += 1;
    } catch (error) {
      if (error instanceof EmailError && error.terminal) {
        console.error(
          `[notifications] ${params.marker} ${params.sessionId} refused (${error.status}), not retrying`,
        );
        continue;
      }
      await db
        .update(sessionBooking)
        .set({ [params.marker]: null })
        .where(and(eq(sessionBooking.id, params.sessionId), eq(column, claimedAt)));
      console.error(`[notifications] ${params.marker} ${params.sessionId} not sent`, error);
      return 0;
    }
  }
  return sent;
}

function answersUnchanged(row: SessionRow): SQL | undefined {
  const same = (column: Column, value: Date | null) =>
    value ? isNotNull(column) : isNull(column);
  return and(
    same(sessionBooking.studentConfirmedAt, row.studentConfirmedAt),
    same(sessionBooking.studentDeniedAt, row.studentDeniedAt),
    same(sessionBooking.tutorConfirmedAt, row.tutorConfirmedAt),
    same(sessionBooking.tutorDeniedAt, row.tutorDeniedAt),
  );
}

function answerOf(row: SessionRow, side: Side): "confirmed" | "denied" | null {
  const [confirmed, denied] =
    side === "student"
      ? [row.studentConfirmedAt, row.studentDeniedAt]
      : [row.tutorConfirmedAt, row.tutorDeniedAt];
  return confirmed ? "confirmed" : denied ? "denied" : null;
}

function sessionQuery() {
  return db
    .select(sessionParties)
    .from(sessionBooking)
    .innerJoin(engagement, eq(engagement.id, sessionBooking.engagementId))
    .innerJoin(studentProfile, eq(studentProfile.id, engagement.studentProfileId))
    .innerJoin(user, eq(user.id, studentProfile.userId))
    .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .innerJoin(tutorUser, eq(tutorUser.id, tutorProfile.userId))
    .innerJoin(courseOffering, eq(courseOffering.id, engagement.courseOfferingId))
    .innerJoin(course, eq(course.id, courseOffering.courseId))
    .leftJoin(
      courseCodeAlias,
      and(eq(courseCodeAlias.courseId, course.id), isNull(courseCodeAlias.validToTermId)),
    );
}

export async function notifyPendingRequests(institutionId: string): Promise<number> {
  const rows = await db
    .select({
      id: matchRequest.id,
      expiresAt: matchRequest.expiresAt,
      tutorEmail: tutorUser.email,
      tutorName: tutorUser.name,
      studentName: user.name,
      code: courseCodeAlias.code,
      title: course.title,
    })
    .from(matchRequest)
    .innerJoin(tutorCourse, eq(tutorCourse.id, matchRequest.tutorCourseId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .innerJoin(tutorUser, eq(tutorUser.id, tutorProfile.userId))
    .innerJoin(studentProfile, eq(studentProfile.id, matchRequest.studentProfileId))
    .innerJoin(user, eq(user.id, studentProfile.userId))
    .innerJoin(course, eq(course.id, tutorCourse.courseId))
    .leftJoin(
      courseCodeAlias,
      and(eq(courseCodeAlias.courseId, course.id), isNull(courseCodeAlias.validToTermId)),
    )
    .where(
      and(
        eq(matchRequest.status, "pending"),
        isNull(matchRequest.tutorNotifiedAt),
        eq(tutorProfile.institutionId, institutionId),
      ),
    );

  let sent = 0;
  for (const row of rows) {
    await sendEmail(
      requestWaiting({
        to: row.tutorEmail,
        tutorName: displayName(row.tutorName, "tutor"),
        studentName: displayName(row.studentName, "student"),
        courseLabel: row.code ?? row.title,
        expiresAt: row.expiresAt,
      }),
    );
    await db
      .update(matchRequest)
      .set({ tutorNotifiedAt: new Date() })
      .where(eq(matchRequest.id, row.id));
    sent += 1;
  }

  return sent;
}

export async function notifyAcceptedRequests(institutionId: string): Promise<number> {
  const rows = await db
    .select({
      id: matchRequest.id,
      studentEmail: user.email,
      studentName: user.name,
      tutorName: tutorUser.name,
      code: courseCodeAlias.code,
      title: course.title,
    })
    .from(matchRequest)
    .innerJoin(tutorCourse, eq(tutorCourse.id, matchRequest.tutorCourseId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .innerJoin(tutorUser, eq(tutorUser.id, tutorProfile.userId))
    .innerJoin(studentProfile, eq(studentProfile.id, matchRequest.studentProfileId))
    .innerJoin(user, eq(user.id, studentProfile.userId))
    .innerJoin(course, eq(course.id, tutorCourse.courseId))
    .leftJoin(
      courseCodeAlias,
      and(eq(courseCodeAlias.courseId, course.id), isNull(courseCodeAlias.validToTermId)),
    )
    .where(
      and(
        eq(matchRequest.status, "accepted"),
        isNull(matchRequest.studentNotifiedAt),
        eq(tutorProfile.institutionId, institutionId),
      ),
    );

  let sent = 0;
  for (const row of rows) {
    await sendEmail(
      requestAccepted({
        to: row.studentEmail,
        studentName: displayName(row.studentName, "student"),
        tutorName: displayName(row.tutorName, "tutor"),
        courseLabel: row.code ?? row.title,
      }),
    );
    await db
      .update(matchRequest)
      .set({ studentNotifiedAt: new Date() })
      .where(eq(matchRequest.id, row.id));
    sent += 1;
  }

  return sent;
}

export async function notifyBookedSessions(institutionId: string): Promise<number> {
  const rows = await sessionQuery().where(
    and(
      eq(sessionBooking.status, "scheduled"),
      isNull(sessionBooking.bookedNotifiedAt),
      campus(institutionId),
    ),
  );

  let sent = 0;
  for (const row of rows) {
    sent += await claimAndSend({
      sessionId: row.sessionId,
      marker: "bookedNotifiedAt",
      unchanged: eq(sessionBooking.status, "scheduled"),
      also: { notifiedLocation: row.location },
      emails: SIDES.map((side) => ({
        ...sessionBooked({
          ...addressed(row, side),
          freeUntil: freeUntil(row.scheduledAt),
          location: row.location,
          studentNote: row.studentNote,
        }),
        idempotencyKey: `session-booked/${row.sessionId}/${side}`,
      })),
    });
  }

  return sent;
}

export async function notifyCancelledSessions(institutionId: string): Promise<number> {
  const rows = await sessionQuery().where(
    and(
      eq(sessionBooking.status, "cancelled"),
      isNotNull(sessionBooking.cancelledByUserId),
      isNull(sessionBooking.cancelNotifiedAt),
      campus(institutionId),
    ),
  );

  let sent = 0;
  for (const row of rows) {
    const side: Side = row.cancelledByUserId === row.studentUserId ? "tutor" : "student";
    sent += await claimAndSend({
      sessionId: row.sessionId,
      marker: "cancelNotifiedAt",
      unchanged: and(
        eq(sessionBooking.status, "cancelled"),
        row.bookedNotifiedAt
          ? isNotNull(sessionBooking.bookedNotifiedAt)
          : isNull(sessionBooking.bookedNotifiedAt),
      ),
      emails: row.bookedNotifiedAt
        ? [
            {
              ...sessionCancelled(addressed(row, side)),
              idempotencyKey: `session-cancelled/${row.sessionId}`,
            },
          ]
        : [],
    });
  }

  return sent;
}

function answeredAt(row: SessionRow, side: Side): Date | null {
  return side === "student"
    ? (row.studentConfirmedAt ?? row.studentDeniedAt)
    : (row.tutorConfirmedAt ?? row.tutorDeniedAt);
}

export async function notifyAnswersDue(institutionId: string): Promise<number> {
  const rows = await sessionQuery().where(
    and(
      eq(sessionBooking.status, "scheduled"),
      isNull(sessionBooking.answerPromptedAt),
      sql`${sessionBooking.scheduledAt} + make_interval(mins => ${sessionBooking.durationMinutes}) <= now()`,
      sql`${sessionBooking.confirmationWindowEndsAt} > now()`,
      campus(institutionId),
    ),
  );

  let sent = 0;
  for (const row of rows) {
    const answerBy = row.confirmationWindowEndsAt;
    if (!answerBy) continue;
    const answers = { student: answerOf(row, "student"), tutor: answerOf(row, "tutor") };
    sent += await claimAndSend({
      sessionId: row.sessionId,
      marker: "answerPromptedAt",
      unchanged: and(eq(sessionBooking.status, "scheduled"), answersUnchanged(row)),
      emails: SIDES.filter((side) => !answers[side]).map((side) => ({
        ...answerDue({
          ...addressed(row, side),
          answerBy,
          otherAnswered: answers[side === "student" ? "tutor" : "student"] !== null,
          deliveredIfUnanswered: deliveredIfUnanswered(answers),
        }),
        idempotencyKey: `session-answer-due/${row.sessionId}/${side}`,
      })),
    });
  }

  return sent;
}

function settledRecipients(row: SessionRow): Side[] {
  const student = answeredAt(row, "student");
  const tutor = answeredAt(row, "tutor");
  const settledByLastAnswer =
    row.resolution === "both_confirmed" ||
    row.resolution === "disputed" ||
    (row.resolution === "resolved_not_attended" &&
      row.studentDeniedAt !== null &&
      row.tutorDeniedAt !== null);

  if (!settledByLastAnswer || !student || !tutor) return SIDES;
  return [student > tutor ? "tutor" : "student"];
}

export async function notifySettledSessions(institutionId: string): Promise<number> {
  const rows = await sessionQuery().where(
    and(
      isNotNull(sessionBooking.resolution),
      isNull(sessionBooking.settledNotifiedAt),
      campus(institutionId),
    ),
  );

  let sent = 0;
  for (const row of rows) {
    const resolution = row.resolution;
    if (!resolution) continue;
    sent += await claimAndSend({
      sessionId: row.sessionId,
      marker: "settledNotifiedAt",
      unchanged: eq(sessionBooking.resolution, resolution),
      emails: settledRecipients(row).map((side) => ({
        ...sessionSettled({ ...addressed(row, side), resolution }),
        idempotencyKey: `session-settled/${row.sessionId}/${resolution}/${side}`,
      })),
    });
  }

  return sent;
}

export async function notifySessionChanges(institutionId: string): Promise<number> {
  return (
    (await notifyBookedSessions(institutionId)) +
    (await notifyCancelledSessions(institutionId)) +
    (await notifySettledSessions(institutionId))
  );
}

export async function notifyUpcomingSessions(institutionId: string): Promise<number> {
  const now = new Date();

  const rows = await sessionQuery().where(
    and(
      eq(sessionBooking.status, "scheduled"),
      isNull(sessionBooking.remindedAt),
      gte(sessionBooking.scheduledAt, now),
      lte(sessionBooking.scheduledAt, reminderHorizon(now)),
      eq(tutorProfile.institutionId, institutionId),
      eq(studentProfile.institutionId, institutionId),
    ),
  );

  let sent = 0;
  for (const row of rows) {
    const shared = {
      courseLabel: row.code ?? row.title,
      scheduledAt: row.scheduledAt,
      freeUntil: freeUntil(row.scheduledAt),
      location: row.location,
      studentNote: row.studentNote,
    };
    const studentName = displayName(row.studentName, "student");
    const tutorName = displayName(row.tutorName, "tutor");

    await sendEmail(
      sessionTomorrow({
        ...shared,
        recipient: "student",
        to: row.studentEmail,
        name: studentName,
        otherPartyName: tutorName,
      }),
    );
    await sendEmail(
      sessionTomorrow({
        ...shared,
        recipient: "tutor",
        to: row.tutorEmail,
        name: tutorName,
        otherPartyName: studentName,
      }),
    );
    await db
      .update(sessionBooking)
      .set({ remindedAt: new Date() })
      .where(eq(sessionBooking.id, row.sessionId));
    sent += 2;
  }

  return sent;
}

export async function notifyCoveredSections(institutionId: string): Promise<number> {
  const covered = db
    .select({ id: tutorCourse.id })
    .from(tutorCourse)
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .where(
      and(
        eq(tutorCourse.courseId, course.id),
        eq(tutorCourse.status, "active"),
        eq(tutorProfile.institutionId, institutionId),
        ne(tutorProfile.userId, studentProfile.userId),
        not(blockedBetween(tutorProfile.userId, studentProfile.userId)),
      ),
    );

  const rows = await db
    .select({
      id: demandSignal.id,
      requestedAt: demandSignal.requestedAt,
      offeringId: courseOffering.id,
      studentEmail: user.email,
      studentName: user.name,
      code: courseCodeAlias.code,
      title: course.title,
    })
    .from(demandSignal)
    .innerJoin(studentProfile, eq(studentProfile.id, demandSignal.studentProfileId))
    .innerJoin(user, eq(user.id, studentProfile.userId))
    .innerJoin(courseOffering, eq(courseOffering.id, demandSignal.courseOfferingId))
    .innerJoin(term, eq(term.id, courseOffering.termId))
    .innerJoin(course, eq(course.id, courseOffering.courseId))
    .leftJoin(
      courseCodeAlias,
      and(eq(courseCodeAlias.courseId, course.id), isNull(courseCodeAlias.validToTermId)),
    )
    .where(
      and(
        isNull(demandSignal.notifiedAt),
        gte(term.endsOn, sql`current_date`),
        eq(studentProfile.institutionId, institutionId),
        eq(course.institutionId, institutionId),
        exists(covered),
      ),
    );

  let sent = 0;
  for (const row of rows) {
    const claimedAt = new Date();
    const claimed = await db
      .update(demandSignal)
      .set({ notifiedAt: claimedAt })
      .where(and(eq(demandSignal.id, row.id), isNull(demandSignal.notifiedAt)))
      .returning({ id: demandSignal.id });
    if (claimed.length === 0) continue;

    try {
      await sendEmail({
        ...sectionCovered({
          to: row.studentEmail,
          studentName: displayName(row.studentName, "student"),
          courseLabel: row.code ?? row.title,
          offeringId: row.offeringId,
        }),
        idempotencyKey: `section-covered/${row.id}/${row.requestedAt.getTime()}`,
      });
      sent += 1;
    } catch (error) {
      await db
        .update(demandSignal)
        .set({ notifiedAt: null })
        .where(and(eq(demandSignal.id, row.id), eq(demandSignal.notifiedAt, claimedAt)));
      console.error(`[notifications] section-covered ${row.id} not sent`, error);
    }
  }

  return sent;
}

export async function notifyVerificationDecisions(institutionId: string): Promise<number> {
  const rows = await db
    .select({
      id: tutorCourse.id,
      status: tutorCourse.status,
      reviewedAt: tutorCourse.reviewedAt,
      rejectionReason: tutorCourse.rejectionReason,
      tutorEmail: tutorUser.email,
      tutorName: tutorUser.name,
      code: courseCodeAlias.code,
      title: course.title,
    })
    .from(tutorCourse)
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .innerJoin(tutorUser, eq(tutorUser.id, tutorProfile.userId))
    .innerJoin(course, eq(course.id, tutorCourse.courseId))
    .leftJoin(
      courseCodeAlias,
      and(eq(courseCodeAlias.courseId, course.id), isNull(courseCodeAlias.validToTermId)),
    )
    .where(
      and(
        inArray(tutorCourse.status, ["active", "rejected"]),
        isNotNull(tutorCourse.reviewedAt),
        isNull(tutorCourse.decisionNotifiedAt),
        eq(tutorProfile.institutionId, institutionId),
        eq(course.institutionId, institutionId),
      ),
    );

  let sent = 0;
  for (const row of rows) {
    if (!row.reviewedAt) continue;

    const claimedAt = new Date();
    const claimed = await db
      .update(tutorCourse)
      .set({ decisionNotifiedAt: claimedAt })
      .where(
        and(
          eq(tutorCourse.id, row.id),
          eq(tutorCourse.status, row.status),
          eq(tutorCourse.reviewedAt, row.reviewedAt),
          isNull(tutorCourse.decisionNotifiedAt),
        ),
      )
      .returning({ id: tutorCourse.id });
    if (claimed.length === 0) continue;

    const shared = {
      to: row.tutorEmail,
      tutorName: displayName(row.tutorName, "tutor"),
      courseLabel: row.code ?? row.title,
    };

    try {
      await sendEmail({
        ...(row.status === "rejected" && row.rejectionReason
          ? claimNeedsNewProof({ ...shared, reason: REJECTION_REASON_COPY[row.rejectionReason] })
          : claimVerified(shared)),
        idempotencyKey: `verification-decision/${row.id}/${row.reviewedAt.getTime()}`,
      });
      sent += 1;
    } catch (error) {
      await db
        .update(tutorCourse)
        .set({ decisionNotifiedAt: null })
        .where(and(eq(tutorCourse.id, row.id), eq(tutorCourse.decisionNotifiedAt, claimedAt)));
      console.error(`[notifications] verification-decision ${row.id} not sent`, error);
    }
  }

  return sent;
}

function reminderHorizon(now: Date): Date {
  const span = now.getTime() - reminderDueAt(now).getTime();
  return new Date(now.getTime() + span);
}

export async function notifyMovedSessions(institutionId: string): Promise<number> {
  const rows = await sessionQuery().where(
    and(
      eq(sessionBooking.status, "scheduled"),
      gt(sessionBooking.scheduledAt, new Date()),
      isNotNull(sessionBooking.bookedNotifiedAt),
      sql`${sessionBooking.location} is distinct from ${sessionBooking.notifiedLocation}`,
      eq(tutorProfile.institutionId, institutionId),
      eq(studentProfile.institutionId, institutionId),
    ),
  );

  let sent = 0;
  for (const row of rows) {
    if (!row.location) continue;

    await sendEmail(
      sessionMoved({
        to: row.studentEmail,
        name: displayName(row.studentName, "student"),
        otherPartyName: displayName(row.tutorName, "tutor"),
        courseLabel: row.code ?? row.title,
        scheduledAt: row.scheduledAt,
        location: row.location,
        firstSpot: row.notifiedLocation === null,
        sessionId: row.sessionId,
      }),
    );
    await db
      .update(sessionBooking)
      .set({ notifiedLocation: row.location })
      .where(eq(sessionBooking.id, row.sessionId));
    sent += 1;
  }

  return sent;
}

export async function runNotifications(institutionId: string): Promise<number> {
  return (
    (await notifyPendingRequests(institutionId)) +
    (await notifyAcceptedRequests(institutionId)) +
    (await notifySessionChanges(institutionId)) +
    (await notifyAnswersDue(institutionId)) +
    (await notifyMovedSessions(institutionId)) +
    (await notifyUpcomingSessions(institutionId)) +
    (await notifyCoveredSections(institutionId)) +
    (await notifyVerificationDecisions(institutionId)) +
    (await notifyUnreadMessages(institutionId))
  );
}
