import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/server/db";
import {
  course,
  courseCodeAlias,
  messageReport,
  messageThread,
  messageThreadAccess,
  studentProfile,
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";
import { tutorUser, type Executor } from "@/server/modules/engagements/access";
import type { Actor, OperatorActor } from "@/server/modules/identity/actor";

import { DELETED_USER, type ReportOutcome, type ReportReason } from "./rules";
import { MessagingError, messagesFor, participantThread, type ThreadMessage } from "./threads";

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

function reportRows(exec: Executor = db) {
  return exec
    .select({
      id: messageReport.id,
      institutionId: messageReport.institutionId,
      threadId: messageReport.threadId,
      reason: messageReport.reason,
      note: messageReport.note,
      createdAt: messageReport.createdAt,
      reviewedAt: messageReport.reviewedAt,
      outcome: messageReport.outcome,
      reporterName: reporter.name,
      studentName: user.name,
      tutorName: tutorUser.name,
      courseLabel: sql<string>`coalesce(${courseCodeAlias.code}, ${course.title})`,
    })
    .from(messageReport)
    .innerJoin(
      messageThread,
      and(
        eq(messageThread.id, messageReport.threadId),
        eq(messageThread.institutionId, messageReport.institutionId),
      ),
    )
    .innerJoin(studentProfile, eq(studentProfile.id, messageThread.studentProfileId))
    .innerJoin(tutorCourse, eq(tutorCourse.id, messageThread.tutorCourseId))
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
  return rows.map(named);
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
    if (!row) throw new MessagingError("That report does not exist.");

    await tx.insert(messageThreadAccess).values({
      institutionId: row.institutionId,
      threadId: row.threadId,
      reportId: row.id,
      operatorUserId: params.operator.userId,
    });

    const report = named(row);
    const messages = await messagesFor(
      tx,
      { id: row.threadId, studentName: row.studentName, tutorName: row.tutorName },
      null,
    );
    return { report, messages };
  });
}

export async function reviewReport(params: {
  operator: OperatorActor;
  reportId: string;
  outcome: ReportOutcome;
}): Promise<void> {
  const updated = await db
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
    .returning({ id: messageReport.id });
  if (updated.length === 0) throw new MessagingError("That report was already reviewed.");
}
