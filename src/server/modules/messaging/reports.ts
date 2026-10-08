import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/server/db";
import {
  course,
  courseCodeAlias,
  messageReport,
  messageThread,
  messageThreadAccess,
  sessionRating,
  sessionRatingAccess,
  studentProfile,
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";
import { tutorUser, type Executor } from "@/server/modules/engagements/access";
import type { Actor, OperatorActor, TutorActor } from "@/server/modules/identity/actor";
import { ratingCounted } from "@/server/modules/ratings/window";

import {
  DELETED_USER,
  outcomesFor,
  type ReportOutcome,
  type ReportReason,
  type ReportSubject,
} from "./rules";
import {
  MessagingError,
  courseLabel,
  messagesFor,
  participantThread,
  type ThreadMessage,
} from "./threads";

const reporter = alias(user, "reporter");

export async function reportThread(params: {
  actor: Actor;
  threadId: string;
  reason: ReportReason;
  note: string | null;
}): Promise<void> {
  const thread = await participantThread(params.actor, params.threadId);
  await db.insert(messageReport).values({
    institutionId: params.actor.institutionId,
    threadId: thread.id,
    reporterUserId: params.actor.userId,
    reason: params.reason,
    note: params.note,
  });
}

export async function reportRating(params: {
  actor: TutorActor;
  sessionRatingId: string;
  reason: ReportReason;
  note: string | null;
}): Promise<void> {
  const rating = (
    await db
      .select({ id: sessionRating.id })
      .from(sessionRating)
      .innerJoin(tutorCourse, eq(tutorCourse.id, sessionRating.tutorCourseId))
      .where(
        and(
          eq(sessionRating.id, params.sessionRatingId),
          eq(sessionRating.institutionId, params.actor.institutionId),
          eq(tutorCourse.tutorProfileId, params.actor.tutorProfileId),
          isNotNull(sessionRating.note),
          ratingCounted,
        ),
      )
      .limit(1)
  ).at(0);
  if (!rating) throw new MessagingError("That rating does not exist.");

  const created = await db
    .insert(messageReport)
    .values({
      institutionId: params.actor.institutionId,
      sessionRatingId: rating.id,
      reporterUserId: params.actor.userId,
      reason: params.reason,
      note: params.note,
    })
    .onConflictDoNothing()
    .returning({ id: messageReport.id });
  if (created.length === 0) throw new MessagingError("You already reported this rating.");
}

function reportRows(exec: Executor = db) {
  return exec
    .select({
      id: messageReport.id,
      institutionId: messageReport.institutionId,
      subject: sql<ReportSubject>`case when ${messageReport.threadId} is null then 'rating' else 'thread' end`,
      threadId: messageReport.threadId,
      sessionRatingId: messageReport.sessionRatingId,
      ratingStars: sessionRating.stars,
      ratingNote: sessionRating.note,
      ratingRemovedAt: sessionRating.removedAt,
      reason: messageReport.reason,
      note: messageReport.note,
      createdAt: messageReport.createdAt,
      reviewedAt: messageReport.reviewedAt,
      outcome: messageReport.outcome,
      reporterName: reporter.name,
      studentName: user.name,
      tutorName: tutorUser.name,
      courseLabel,
    })
    .from(messageReport)
    .leftJoin(
      messageThread,
      and(
        eq(messageThread.id, messageReport.threadId),
        eq(messageThread.institutionId, messageReport.institutionId),
      ),
    )
    .leftJoin(
      sessionRating,
      and(
        eq(sessionRating.id, messageReport.sessionRatingId),
        eq(sessionRating.institutionId, messageReport.institutionId),
      ),
    )
    .innerJoin(
      studentProfile,
      eq(studentProfile.id, sql`coalesce(${messageThread.studentProfileId}, ${sessionRating.studentProfileId})`),
    )
    .innerJoin(
      tutorCourse,
      eq(tutorCourse.id, sql`coalesce(${messageThread.tutorCourseId}, ${sessionRating.tutorCourseId})`),
    )
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .innerJoin(course, eq(course.id, tutorCourse.courseId))
    .leftJoin(user, eq(user.id, studentProfile.userId))
    .leftJoin(tutorUser, eq(tutorUser.id, tutorProfile.userId))
    .leftJoin(reporter, eq(reporter.id, messageReport.reporterUserId))
    .leftJoin(
      courseCodeAlias,
      and(eq(courseCodeAlias.courseId, course.id), isNull(courseCodeAlias.validToTermId)),
    );
}

type ReportRow = Awaited<ReturnType<typeof reportRows>>[number];

export type ReportItem = Omit<ReportRow, "reporterName" | "studentName" | "tutorName"> & {
  reporterName: string;
  studentName: string;
  tutorName: string;
};

function named(row: ReportRow): ReportItem {
  return {
    ...row,
    reporterName: row.reporterName ?? DELETED_USER,
    studentName: row.studentName ?? DELETED_USER,
    tutorName: row.tutorName ?? DELETED_USER,
  };
}

function onOperatorCampus(operator: OperatorActor) {
  return inArray(messageReport.institutionId, operator.operatorInstitutionIds);
}

export async function reportsForOperator(operator: OperatorActor): Promise<ReportItem[]> {
  const rows = await reportRows()
    .where(onOperatorCampus(operator))
    .orderBy(sql`${messageReport.reviewedAt} is not null`, desc(messageReport.createdAt))
    .limit(100);
  return rows.map((row) => ({ ...named(row), ratingStars: null, ratingNote: null }));
}

export async function openReportedThread(params: {
  operator: OperatorActor;
  reportId: string;
}): Promise<{ report: ReportItem; messages: ThreadMessage[] }> {
  return db.transaction(async (tx) => {
    const row = (
      await reportRows(tx)
        .where(and(eq(messageReport.id, params.reportId), onOperatorCampus(params.operator)))
        .limit(1)
    ).at(0);
    if (!row?.threadId) throw new MessagingError("That report does not exist.");
    const threadId = row.threadId;

    await tx.insert(messageThreadAccess).values({
      institutionId: row.institutionId,
      threadId,
      reportId: row.id,
      operatorUserId: params.operator.userId,
    });

    const report = named(row);
    const messages = await messagesFor(
      tx,
      { id: threadId, studentName: row.studentName, tutorName: row.tutorName },
      null,
    );
    return { report, messages };
  });
}

export async function openReportedRating(params: {
  operator: OperatorActor;
  reportId: string;
}): Promise<ReportItem> {
  return db.transaction(async (tx) => {
    const row = (
      await reportRows(tx)
        .where(
          and(
            eq(messageReport.id, params.reportId),
            onOperatorCampus(params.operator),
            isNotNull(messageReport.sessionRatingId),
          ),
        )
        .limit(1)
    ).at(0);
    if (!row?.sessionRatingId) throw new MessagingError("That report does not exist.");

    await tx.insert(sessionRatingAccess).values({
      institutionId: row.institutionId,
      sessionRatingId: row.sessionRatingId,
      reportId: row.id,
      operatorUserId: params.operator.userId,
    });
    return named(row);
  });
}

export async function reviewReport(params: {
  operator: OperatorActor;
  reportId: string;
  outcome: ReportOutcome;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [report] = await tx
      .update(messageReport)
      .set({
        reviewedAt: new Date(),
        reviewedByUserId: params.operator.userId,
        outcome: params.outcome,
      })
      .where(
        and(
          eq(messageReport.id, params.reportId),
          onOperatorCampus(params.operator),
          isNull(messageReport.reviewedAt),
        ),
      )
      .returning({
        institutionId: messageReport.institutionId,
        sessionRatingId: messageReport.sessionRatingId,
      });
    if (!report) throw new MessagingError("That report was already reviewed.");

    const subject: ReportSubject = report.sessionRatingId ? "rating" : "thread";
    if (!outcomesFor(subject).includes(params.outcome)) {
      throw new MessagingError("Only a rating can be removed.");
    }
    if (params.outcome !== "removed" || !report.sessionRatingId) return;

    await tx
      .update(sessionRating)
      .set({ removedAt: new Date(), removedByUserId: params.operator.userId })
      .where(
        and(
          eq(sessionRating.id, report.sessionRatingId),
          eq(sessionRating.institutionId, report.institutionId),
          isNull(sessionRating.removedAt),
        ),
      );
    await tx
      .update(messageReport)
      .set({ reviewedAt: new Date(), reviewedByUserId: params.operator.userId, outcome: "removed" })
      .where(
        and(
          eq(messageReport.sessionRatingId, report.sessionRatingId),
          eq(messageReport.institutionId, report.institutionId),
          isNull(messageReport.reviewedAt),
        ),
      );
  });
}
