import { and, eq, isNull, not, or, sql, type SQL } from "drizzle-orm";

import { db } from "@/server/db";
import {
  course,
  courseCodeAlias,
  message,
  messageThread,
  studentProfile,
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";
import { tutorUser } from "@/server/modules/engagements/access";
import { displayName } from "@/server/modules/identity/display-name";
import { sendEmail } from "@/server/modules/notifications/email";
import { messageWaiting } from "@/server/modules/notifications/messages";

import { ALERT_GAP_MINUTES, THREAD_SIDES, otherSide, previewLine, type ThreadSide } from "./rules";
import { courseLabel, readThroughColumn, threadBlocked, unreadFor } from "./threads";

const ALERTED = {
  student: { column: messageThread.studentAlertedAt, key: "studentAlertedAt" },
  tutor: { column: messageThread.tutorAlertedAt, key: "tutorAlertedAt" },
} as const;

function alertDue(side: ThreadSide): SQL {
  const alerted = ALERTED[side].column;
  return and(
    unreadFor(side),
    or(
      isNull(alerted),
      and(
        sql`${alerted} <= now() - make_interval(mins => ${ALERT_GAP_MINUTES})`,
        not(unreadFor(side, alerted)),
      ),
    ),
    not(threadBlocked),
  )!;
}

async function alertSide(side: ThreadSide, scope: SQL): Promise<number> {
  const recipient = side === "student" ? user : tutorUser;
  const sender = side === "student" ? tutorUser : user;
  const alerted = ALERTED[side];

  const latest = sql`(
    select ${message.id} from ${message}
    where ${message.threadId} = ${messageThread.id}
      and ${message.senderSide} = ${otherSide(side)}
      and ${message.createdAt} > coalesce(${readThroughColumn(side)}, '-infinity')
    order by ${message.createdAt} desc limit 1
  )`;

  const rows = await db
    .select({
      threadId: messageThread.id,
      alertedAt: alerted.column,
      to: recipient.email,
      recipientName: recipient.name,
      senderName: sender.name,
      courseLabel,
      messageId: sql<string>`${latest}`,
      body: sql<string>`(select ${message.body} from ${message} where ${message.id} = ${latest})`,
    })
    .from(messageThread)
    .innerJoin(studentProfile, eq(studentProfile.id, messageThread.studentProfileId))
    .innerJoin(user, eq(user.id, studentProfile.userId))
    .innerJoin(tutorCourse, eq(tutorCourse.id, messageThread.tutorCourseId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .innerJoin(tutorUser, eq(tutorUser.id, tutorProfile.userId))
    .innerJoin(course, eq(course.id, tutorCourse.courseId))
    .leftJoin(
      courseCodeAlias,
      and(eq(courseCodeAlias.courseId, course.id), isNull(courseCodeAlias.validToTermId)),
    )
    .where(and(scope, alertDue(side)));

  let sent = 0;
  for (const row of rows) {
    const claimed = await db
      .update(messageThread)
      .set({ [alerted.key]: sql`date_trunc('milliseconds', now())` })
      .where(
        and(
          eq(messageThread.id, row.threadId),
          row.alertedAt ? eq(alerted.column, row.alertedAt) : isNull(alerted.column),
          alertDue(side),
        ),
      )
      .returning({ at: alerted.column });
    const claimedAt = claimed.at(0)?.at;
    if (!claimedAt) continue;

    try {
      await sendEmail({
        ...messageWaiting({
          to: row.to,
          recipientName: displayName(row.recipientName, side),
          senderName: displayName(row.senderName, otherSide(side)),
          courseLabel: row.courseLabel,
          preview: previewLine(row.body),
          threadId: row.threadId,
        }),
        idempotencyKey: `message-alert/${row.threadId}/${side}/${row.messageId}`,
      });
      sent += 1;
    } catch (error) {
      await db
        .update(messageThread)
        .set({ [alerted.key]: row.alertedAt })
        .where(and(eq(messageThread.id, row.threadId), eq(alerted.column, claimedAt)));
      console.error(`[notifications] message-alert ${row.threadId}/${side} not sent`, error);
    }
  }

  return sent;
}

export async function alertThread(threadId: string, side: ThreadSide): Promise<number> {
  return alertSide(side, eq(messageThread.id, threadId));
}

export async function notifyUnreadMessages(institutionId: string): Promise<number> {
  let sent = 0;
  for (const side of THREAD_SIDES) {
    sent += await alertSide(side, eq(messageThread.institutionId, institutionId));
  }
  return sent;
}
