import { and, eq, inArray, like, or } from "drizzle-orm";

import { db } from "../index";
import { escapeLike } from "../like";
import {
  demandSignal,
  engagement,
  enrollment,
  institutionEmail,
  ledgerEntry,
  matchRequest,
  message,
  messageReport,
  messageThread,
  messageThreadAccess,
  moneyDiscrepancy,
  operator,
  paymentDispute,
  reliabilityEvent,
  sessionBooking,
  sessionRating,
  sessionRatingAccess,
  studentProfile,
  tutorAvailability,
  tutorCourse,
  tutorProfile,
  user,
  userBlock,
  verificationFile,
} from "../schema";

import { PERSONA_PREFIX } from "@/server/modules/billing/fixtures";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type People = { userIds: string[]; studentIds: string[]; tutorCourseIds: string[] };

const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

const touching = (
  table: typeof engagement | typeof matchRequest | typeof messageThread | typeof sessionRating,
  institutionId: string,
  people: People,
) =>
  and(
    eq(table.institutionId, institutionId),
    or(inArray(table.studentProfileId, people.studentIds), inArray(table.tutorCourseId, people.tutorCourseIds)),
  );

/** A row with a persona on one side and a real account on the other is not the reset's to delete. */
async function refuseMixed(tx: Tx, institutionId: string, people: People): Promise<void> {
  const students = new Set(people.studentIds);
  const tutorCourses = new Set(people.tutorCourseIds);
  const mixed: string[] = [];

  for (const [table, label] of [
    [engagement, "engagement"],
    [matchRequest, "match_request"],
    [messageThread, "message_thread"],
    [sessionRating, "session_rating"],
  ] as const) {
    const rows = await tx
      .select({ id: table.id, studentProfileId: table.studentProfileId, tutorCourseId: table.tutorCourseId })
      .from(table)
      .where(touching(table, institutionId, people));
    for (const row of rows) {
      if (students.has(row.studentProfileId) !== tutorCourses.has(row.tutorCourseId)) mixed.push(`${label} ${row.id}`);
    }
  }

  const personas = new Set(people.userIds);
  const blocks = await tx
    .select({ blocker: userBlock.blockerUserId, blocked: userBlock.blockedUserId })
    .from(userBlock)
    .where(
      and(
        eq(userBlock.institutionId, institutionId),
        or(inArray(userBlock.blockerUserId, people.userIds), inArray(userBlock.blockedUserId, people.userIds)),
      ),
    );
  for (const block of blocks) {
    if (personas.has(block.blocker) !== personas.has(block.blocked)) mixed.push(`user_block ${block.blocker} → ${block.blocked}`);
  }

  if (mixed.length > 0) {
    throw new Error(`Refusing to reset personas: these rows pair a persona with a real account. Clear them by hand first.\n${mixed.join("\n")}`);
  }
}

/** Deletes every persona on the campus and everything that hangs off them, and nothing else. */
export async function wipePersonas(institutionId: string): Promise<{ users: number }> {
  return db.transaction(async (tx) => {
    const people = await tx
      .select({ id: user.id, email: user.email, studentProfileId: studentProfile.id, tutorProfileId: tutorProfile.id })
      .from(user)
      .innerJoin(studentProfile, eq(studentProfile.userId, user.id))
      .leftJoin(tutorProfile, eq(tutorProfile.userId, user.id))
      .where(and(like(user.id, `${escapeLike(PERSONA_PREFIX)}%`), eq(studentProfile.institutionId, institutionId)));
    if (people.length === 0) return { users: 0 };

    const userIds = ids(people);
    const studentIds = people.map((row) => row.studentProfileId);
    const tutorIds = people.flatMap((row) => (row.tutorProfileId ? [row.tutorProfileId] : []));
    const tutorCourseIds = tutorIds.length
      ? ids(
          await tx
            .select({ id: tutorCourse.id })
            .from(tutorCourse)
            .where(and(eq(tutorCourse.institutionId, institutionId), inArray(tutorCourse.tutorProfileId, tutorIds))),
        )
      : [];

    const scope: People = { userIds, studentIds, tutorCourseIds };
    await refuseMixed(tx, institutionId, scope);
    const ofPersonas = (table: Parameters<typeof touching>[0]) => touching(table, institutionId, scope);

    const engagementIds = ids(await tx.select({ id: engagement.id }).from(engagement).where(ofPersonas(engagement)));
    const sessionIds = engagementIds.length
      ? ids(await tx.select({ id: sessionBooking.id }).from(sessionBooking).where(inArray(sessionBooking.engagementId, engagementIds)))
      : [];
    const threadIds = ids(await tx.select({ id: messageThread.id }).from(messageThread).where(ofPersonas(messageThread)));
    const ratingIds = ids(await tx.select({ id: sessionRating.id }).from(sessionRating).where(ofPersonas(sessionRating)));
    const reportIds = ids(
      await tx
        .select({ id: messageReport.id })
        .from(messageReport)
        .where(
          and(
            eq(messageReport.institutionId, institutionId),
            or(
              inArray(messageReport.threadId, threadIds),
              inArray(messageReport.sessionRatingId, ratingIds),
              inArray(messageReport.reporterUserId, userIds),
            ),
          ),
        ),
    );

    await tx
      .delete(sessionRatingAccess)
      .where(or(inArray(sessionRatingAccess.sessionRatingId, ratingIds), inArray(sessionRatingAccess.reportId, reportIds)));
    await tx
      .delete(messageThreadAccess)
      .where(or(inArray(messageThreadAccess.threadId, threadIds), inArray(messageThreadAccess.reportId, reportIds)));
    await tx.delete(messageReport).where(inArray(messageReport.id, reportIds));
    await tx.delete(sessionRating).where(inArray(sessionRating.id, ratingIds));
    await tx.delete(message).where(inArray(message.threadId, threadIds));
    await tx.delete(messageThread).where(inArray(messageThread.id, threadIds));
    await tx
      .delete(reliabilityEvent)
      .where(
        and(
          eq(reliabilityEvent.institutionId, institutionId),
          or(inArray(reliabilityEvent.userId, userIds), inArray(reliabilityEvent.sessionId, sessionIds)),
        ),
      );
    if (engagementIds.length > 0) {
      await tx
        .delete(moneyDiscrepancy)
        .where(and(eq(moneyDiscrepancy.institutionId, institutionId), inArray(moneyDiscrepancy.engagementId, engagementIds)));
      await tx
        .delete(paymentDispute)
        .where(and(eq(paymentDispute.institutionId, institutionId), inArray(paymentDispute.engagementId, engagementIds)));
      await tx.delete(ledgerEntry).where(inArray(ledgerEntry.engagementId, engagementIds));
      await tx.delete(sessionBooking).where(inArray(sessionBooking.engagementId, engagementIds));
      await tx.delete(engagement).where(inArray(engagement.id, engagementIds));
    }
    await tx.delete(matchRequest).where(ofPersonas(matchRequest));
    await tx.delete(demandSignal).where(inArray(demandSignal.studentProfileId, studentIds));
    await tx.delete(enrollment).where(inArray(enrollment.studentProfileId, studentIds));
    await tx.delete(verificationFile).where(inArray(verificationFile.tutorCourseId, tutorCourseIds));
    await tx.delete(tutorCourse).where(inArray(tutorCourse.id, tutorCourseIds));
    await tx.delete(tutorAvailability).where(inArray(tutorAvailability.tutorProfileId, tutorIds));
    await tx.delete(tutorProfile).where(inArray(tutorProfile.id, tutorIds));
    await tx.delete(studentProfile).where(inArray(studentProfile.id, studentIds));
    await tx
      .delete(userBlock)
      .where(
        and(
          eq(userBlock.institutionId, institutionId),
          or(inArray(userBlock.blockerUserId, userIds), inArray(userBlock.blockedUserId, userIds)),
        ),
      );
    await tx.delete(operator).where(and(eq(operator.institutionId, institutionId), inArray(operator.userId, userIds)));
    await tx
      .delete(institutionEmail)
      .where(and(eq(institutionEmail.institutionId, institutionId), inArray(institutionEmail.email, people.map((row) => row.email))));
    await tx.delete(user).where(inArray(user.id, userIds));

    return { users: userIds.length };
  });
}
