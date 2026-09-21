import { and, eq, gte, isNull, lte } from "drizzle-orm";

import { db } from "@/server/db";
import {
  course,
  courseCodeAlias,
  courseOffering,
  engagement,
  matchRequest,
  sessionBooking,
  studentProfile,
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";
import { tutorUser } from "@/server/modules/engagements/access";
import { LATE_CANCEL_HOURS, reminderDueAt } from "@/server/modules/engagements/attendance";
import { displayName } from "@/server/modules/identity/display-name";

import { sendEmail } from "./email";
import {
  requestAccepted,
  requestWaiting,
  sessionBooked,
  sessionTomorrow,
} from "./messages";

function freeUntil(scheduledAt: Date): Date {
  return new Date(scheduledAt.getTime() - LATE_CANCEL_HOURS * 60 * 60 * 1000);
}

const sessionParties = {
  sessionId: sessionBooking.id,
  scheduledAt: sessionBooking.scheduledAt,
  locationNote: sessionBooking.locationNote,
  studentEmail: user.email,
  studentName: user.name,
  tutorEmail: tutorUser.email,
  tutorName: tutorUser.name,
  code: courseCodeAlias.code,
  title: course.title,
};

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
      locationNote: row.locationNote,
    };
    const studentName = displayName(row.studentName, "student");
    const tutorName = displayName(row.tutorName, "tutor");

    await sendEmail(
      sessionBooked({ ...shared, to: row.studentEmail, name: studentName, otherPartyName: tutorName }),
    );
    await sendEmail(
      sessionBooked({ ...shared, to: row.tutorEmail, name: tutorName, otherPartyName: studentName }),
    );
    await db
      .update(sessionBooking)
      .set({ bookedNotifiedAt: new Date() })
      .where(eq(sessionBooking.id, row.sessionId));
    sent += 2;
  }

  return sent;
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
    };
    const studentName = displayName(row.studentName, "student");
    const tutorName = displayName(row.tutorName, "tutor");

    await sendEmail(
      sessionTomorrow({ ...shared, to: row.studentEmail, name: studentName, otherPartyName: tutorName }),
    );
    await sendEmail(
      sessionTomorrow({ ...shared, to: row.tutorEmail, name: tutorName, otherPartyName: studentName }),
    );
    await db
      .update(sessionBooking)
      .set({ remindedAt: new Date() })
      .where(eq(sessionBooking.id, row.sessionId));
    sent += 2;
  }

  return sent;
}

function reminderHorizon(now: Date): Date {
  const span = now.getTime() - reminderDueAt(now).getTime();
  return new Date(now.getTime() + span);
}

export async function runNotifications(institutionId: string): Promise<number> {
  return (
    (await notifyPendingRequests(institutionId)) +
    (await notifyAcceptedRequests(institutionId)) +
    (await notifyBookedSessions(institutionId)) +
    (await notifyUpcomingSessions(institutionId))
  );
}
