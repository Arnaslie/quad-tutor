import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { isLocalHost } from "@/server/db/local-host.mjs";
import {
  course,
  courseCodeAlias,
  courseOffering,
  demandSignal,
  engagement,
  institution,
  ledgerEntry,
  matchRequest,
  message,
  messageReport,
  messageThread,
  messageThreadAccess,
  operator,
  sessionBooking,
  studentProfile,
  term,
  tutorCourse,
  tutorProfile,
  user,
  userBlock,
} from "@/server/db/schema";
import { purchasePackage, purchaseTopUp } from "@/server/modules/engagements/purchase";
import type { Actor, OperatorActor, TutorActor } from "@/server/modules/identity/actor";
import { buildDeck } from "@/server/modules/matching/candidates";
import { acceptRequest, requestTutors } from "@/server/modules/matching/requests";
import { notifyCoveredSections } from "@/server/modules/notifications/dispatch";

import { alertThread, notifyUnreadMessages } from "./alerts";
import { openReportedThread, reportThread, reportsForOperator, reviewReport } from "./reports";
import { DELETED_USER, SENDS_PER_HOUR, previewLine } from "./rules";
import { MessagingError, blockThread, inboxFor, sendMessage, threadView, unreadTotal } from "./threads";

const databaseHost = new URL(process.env.DATABASE_URL ?? "postgres://unset").hostname;
if (!isLocalHost(databaseHost)) {
  throw new Error(`Refusing to run tests against ${databaseHost}: point DATABASE_URL at a local database.`);
}

delete process.env.RESEND_API_KEY;

const run = randomUUID().slice(0, 8);
const made = { institutions: [] as string[], users: [] as string[] };

let home: { institutionId: string; offeringId: string; courseId: string };
let student: Actor;
let stranger: Actor;
let tutor: TutorActor;
let otherTutor: TutorActor;
let ops: OperatorActor;
let awayOps: OperatorActor;
let threadId: string;
let otherThreadId: string;

const alerts: string[] = [];
const log = console.log;
console.log = (...args: unknown[]) => {
  const line = String(args[0] ?? "");
  if (line.startsWith("[email] idempotency-key: message-alert/")) alerts.push(line);
  else if (!line.startsWith("[email]") && !line.startsWith("\n[email]")) log(...args);
};

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function campus(slug: string) {
  const [inst] = await db
    .insert(institution)
    .values({ name: `Test ${slug}`, slug: `msg-${slug}-${run}`, emailDomain: `${slug}-${run}.test`, timezone: "America/Chicago" })
    .returning({ id: institution.id });
  made.institutions.push(inst.id);
  const [termRow] = await db
    .insert(term)
    .values({ institutionId: inst.id, name: "Now", startsOn: inDays(-90), endsOn: inDays(14) })
    .returning({ id: term.id });
  const [courseRow] = await db
    .insert(course)
    .values({ institutionId: inst.id, title: "Messaging 101", department: "TEST" })
    .returning({ id: course.id });
  await db.insert(courseCodeAlias).values({ courseId: courseRow.id, code: `MSG ${run}` });
  const [offering] = await db
    .insert(courseOffering)
    .values({ courseId: courseRow.id, termId: termRow.id, section: "001" })
    .returning({ id: courseOffering.id });
  return { institutionId: inst.id, termId: termRow.id, courseId: courseRow.id, offeringId: offering.id };
}

async function person(key: string, institutionId: string): Promise<Actor> {
  const id = `test_msg_${key}_${run}`;
  await db.insert(user).values({ id, name: key, email: `${id}@example.test`, emailVerified: true });
  made.users.push(id);
  const [profile] = await db
    .insert(studentProfile)
    .values({ userId: id, institutionId })
    .returning({ id: studentProfile.id });
  return { userId: id, name: key, email: `${id}@example.test`, institutionId, studentProfileId: profile.id, tutorProfileId: null };
}

async function tutorFor(key: string, place: { institutionId: string; courseId: string; termId: string }) {
  const base = await person(key, place.institutionId);
  const [profile] = await db
    .insert(tutorProfile)
    .values({ userId: base.userId, institutionId: place.institutionId })
    .returning({ id: tutorProfile.id });
  await db.insert(tutorCourse).values({
    tutorProfileId: profile.id,
    courseId: place.courseId,
    takenTermId: place.termId,
    gradeEarned: "A",
    status: "active",
  });
  return { ...base, tutorProfileId: profile.id };
}

async function operatorFor(key: string, institutionId: string): Promise<OperatorActor> {
  const base = await person(key, institutionId);
  await db.insert(operator).values({ userId: base.userId, institutionId });
  return { ...base, operatorInstitutionIds: [institutionId] };
}

async function threadOf(actor: TutorActor): Promise<string> {
  const [row] = await db
    .select({ id: messageThread.id })
    .from(messageThread)
    .innerJoin(tutorCourse, eq(tutorCourse.id, messageThread.tutorCourseId))
    .where(and(eq(messageThread.studentProfileId, student.studentProfileId), eq(tutorCourse.tutorProfileId, actor.tutorProfileId)));
  return row.id;
}

async function passMinutes(minutes: number) {
  const back = sql`make_interval(mins => ${minutes})`;
  await db
    .update(messageThread)
    .set({
      studentAlertedAt: sql`${messageThread.studentAlertedAt} - ${back}`,
      studentReadThrough: sql`${messageThread.studentReadThrough} - ${back}`,
    })
    .where(eq(messageThread.id, threadId));
  await db
    .update(message)
    .set({ createdAt: sql`${message.createdAt} - ${back}` })
    .where(eq(message.threadId, threadId));
}

async function tutorSays(body: string) {
  const { recipient } = await sendMessage({ actor: tutor, threadId, body });
  return alertThread(threadId, recipient);
}

before(async () => {
  const place = await campus("home");
  const away = await campus("away");
  home = place;

  student = await person("student", place.institutionId);
  stranger = await person("stranger", place.institutionId);
  tutor = await tutorFor("tutor", place);
  otherTutor = await tutorFor("other-tutor", place);
  ops = await operatorFor("ops", place.institutionId);
  awayOps = await operatorFor("away-ops", away.institutionId);

  const asked = await requestTutors({
    actor: student,
    courseOfferingId: place.offeringId,
    tutorCourseIds: (
      await db.select({ id: tutorCourse.id }).from(tutorCourse).where(eq(tutorCourse.courseId, place.courseId))
    ).map((row) => row.id),
  });
  assert.equal(asked.created, 2);
  threadId = await threadOf(tutor);
  otherThreadId = await threadOf(otherTutor);
});

beforeEach(async () => {
  alerts.length = 0;
  await db.delete(message).where(inArray(message.threadId, [threadId, otherThreadId]));
  await db
    .update(messageThread)
    .set({ studentReadThrough: null, tutorReadThrough: null, studentAlertedAt: null, tutorAlertedAt: null })
    .where(inArray(messageThread.id, [threadId, otherThreadId]));
});

after(async () => {
  console.log = log;
  const institutions = made.institutions;
  const threads = await db.select({ id: messageThread.id }).from(messageThread).where(inArray(messageThread.institutionId, institutions));
  const threadIds = threads.map((row) => row.id);
  const engagements = await db
    .select({ id: engagement.id })
    .from(engagement)
    .innerJoin(studentProfile, eq(studentProfile.id, engagement.studentProfileId))
    .where(inArray(studentProfile.institutionId, institutions));
  const engagementIds = engagements.map((row) => row.id);
  const courseIds = (await db.select({ id: course.id }).from(course).where(inArray(course.institutionId, institutions))).map((row) => row.id);

  if (threadIds.length) {
    await db.delete(messageThreadAccess).where(inArray(messageThreadAccess.threadId, threadIds));
    await db.delete(messageReport).where(inArray(messageReport.threadId, threadIds));
    await db.delete(message).where(inArray(message.threadId, threadIds));
    await db.delete(messageThread).where(inArray(messageThread.id, threadIds));
  }
  await db.delete(userBlock).where(inArray(userBlock.institutionId, institutions));
  if (engagementIds.length) {
    await db.delete(ledgerEntry).where(inArray(ledgerEntry.engagementId, engagementIds));
    await db.delete(sessionBooking).where(inArray(sessionBooking.engagementId, engagementIds));
    await db.delete(engagement).where(inArray(engagement.id, engagementIds));
  }
  await db.delete(matchRequest).where(inArray(matchRequest.courseOfferingId, [home.offeringId]));
  await db.delete(demandSignal).where(inArray(demandSignal.courseOfferingId, [home.offeringId]));
  await db.delete(tutorCourse).where(inArray(tutorCourse.courseId, courseIds));
  await db.delete(operator).where(inArray(operator.userId, made.users));
  await db.delete(tutorProfile).where(inArray(tutorProfile.userId, made.users));
  await db.delete(studentProfile).where(inArray(studentProfile.userId, made.users));
  await db.delete(user).where(inArray(user.id, made.users));
  await db.delete(courseOffering).where(inArray(courseOffering.courseId, courseIds));
  await db.delete(courseCodeAlias).where(inArray(courseCodeAlias.courseId, courseIds));
  await db.delete(course).where(inArray(course.id, courseIds));
  await db.delete(term).where(inArray(term.institutionId, institutions));
  await db.delete(institution).where(inArray(institution.id, institutions));
  await db.$client.end();
});

test("a request opens one thread per pair", async () => {
  const rows = await db.select({ id: messageThread.id }).from(messageThread).where(eq(messageThread.studentProfileId, student.studentProfileId));
  assert.equal(rows.length, 2);
  assert.equal((await threadView(student, threadId)).open, true);
});

test("a burst of ten messages sends one email", async () => {
  let sent = 0;
  for (let index = 0; index < 10; index += 1) sent += await tutorSays(`Burst message ${index}`);
  sent += await notifyUnreadMessages(home.institutionId);
  assert.equal(sent, 1);
  assert.equal(alerts.length, 1);
  assert.equal(await unreadTotal(student), 10);

  await passMinutes(16);
  assert.equal(await notifyUnreadMessages(home.institutionId), 0, "no second email until the recipient reads");
});

test("after a read, the next email waits for 15 minutes since the last one", async () => {
  assert.equal(await tutorSays("First"), 1);
  await threadView(student, threadId);
  assert.equal(await unreadTotal(student), 0);

  assert.equal(await tutorSays("Second, five minutes later"), 0);
  assert.equal(await notifyUnreadMessages(home.institutionId), 0);

  await passMinutes(16);
  assert.equal(await notifyUnreadMessages(home.institutionId), 1);
  assert.equal(await tutorSays("Third, unread second"), 0);
  assert.equal(alerts.length, 2);
});

test("after() and the sweep overlapping send one email", async () => {
  for (let round = 1; round <= 5; round += 1) {
    await sendMessage({ actor: tutor, threadId, body: `Race me, round ${round}` });
    const results = await Promise.all([
      alertThread(threadId, "student"),
      notifyUnreadMessages(home.institutionId),
      alertThread(threadId, "student"),
      notifyUnreadMessages(home.institutionId),
    ]);
    assert.equal(results.reduce((sum, value) => sum + value, 0), 1);
    await threadView(student, threadId);
    await passMinutes(16);
  }
  assert.equal(alerts.length, 5);
});

test("a blocked pair can't send, gets no email, and drops out of matching", async () => {
  await sendMessage({ actor: tutor, threadId, body: "Unread before the block" });
  await blockThread({ actor: student, threadId, blocked: true });

  assert.equal(await alertThread(threadId, "student"), 0);
  assert.equal(await notifyUnreadMessages(home.institutionId), 0);
  await assert.rejects(sendMessage({ actor: student, threadId, body: "hi" }), MessagingError);
  await assert.rejects(sendMessage({ actor: tutor, threadId, body: "hi" }), MessagingError);

  const view = await threadView(student, threadId);
  assert.equal(view.blocked, true);
  assert.equal(view.blockedByMe, true);
  assert.equal((await threadView(tutor, threadId)).blockedByMe, false);

  const deck = await buildDeck({ courseOfferingId: home.offeringId, institutionId: home.institutionId, viewerUserId: student.userId });
  assert.deepEqual(deck.candidates.map((card) => card.tutorProfileId), [otherTutor.tutorProfileId]);

  await db.update(tutorCourse).set({ status: "retired" }).where(eq(tutorCourse.tutorProfileId, otherTutor.tutorProfileId));
  await db.insert(demandSignal).values({ studentProfileId: student.studentProfileId, courseOfferingId: home.offeringId });
  assert.equal(await notifyCoveredSections(home.institutionId), 0, "a blocked tutor does not count as coverage");
  await db.update(tutorCourse).set({ status: "active" }).where(eq(tutorCourse.tutorProfileId, otherTutor.tutorProfileId));
  await db.delete(demandSignal).where(eq(demandSignal.studentProfileId, student.studentProfileId));

  await blockThread({ actor: student, threadId, blocked: false });
  assert.equal(await tutorSays("After the unblock"), 1);
  assert.equal(alerts.length, 1);
});

test("a withdrawn tutor keeps a read-only thread", async () => {
  await acceptRequest({ tutor, requestId: await requestId(tutor) });
  const view = await threadView(otherTutor, otherThreadId);
  assert.equal(view.open, false);
  assert.equal(view.bookAgainHref, null);
  await assert.rejects(sendMessage({ actor: otherTutor, threadId: otherThreadId, body: "hi" }), MessagingError);
  assert.equal((await threadView(student, threadId)).open, true, "accepted and not yet bought stays open");
});

test("a closed thread offers booking and refuses a send; buying reopens it", async () => {
  const { engagementId } = await purchasePackage({
    actor: student,
    requestId: await requestId(tutor),
    kind: "exam_anchored",
    anchorExamId: null,
    slotStartsAt: new Date(Date.now() + 3 * 86_400_000),
  });
  assert.equal((await threadView(student, threadId)).open, true);

  await db
    .update(engagement)
    .set({ status: "completed", sessionsPurchased: 1, completedAt: new Date() })
    .where(eq(engagement.id, engagementId));

  const closed = await threadView(student, threadId);
  assert.equal(closed.open, false);
  assert.equal(closed.bookAgainHref, `/sessions?topup=${engagementId}`);
  await assert.rejects(sendMessage({ actor: student, threadId, body: "hello?" }), MessagingError);
  assert.equal(closed.messages.length, 0);

  await purchaseTopUp({ actor: student, engagementId, slotStartsAt: new Date(Date.now() + 4 * 86_400_000) });
  assert.equal((await threadView(student, threadId)).open, true);
  await sendMessage({ actor: student, threadId, body: "Booked again" });
});

test("a report is visible to its campus's operator only, and every open is audited", async () => {
  await sendMessage({ actor: tutor, threadId, body: "Something reportable" });
  await assert.rejects(reportThread({ actor: stranger, threadId, reason: "spam", note: null }), MessagingError);
  await reportThread({ actor: student, threadId, reason: "harassment", note: "Not okay" });

  const mine = await reportsForOperator(ops);
  assert.equal(mine.filter((report) => report.threadId === threadId).length, 1);
  assert.equal((await reportsForOperator(awayOps)).length, 0);

  const reportId = mine[0].id;
  await assert.rejects(openReportedThread({ operator: awayOps, reportId }), MessagingError);

  const count = async () =>
    (await db.select({ n: sql<number>`count(*)::int` }).from(messageThreadAccess).where(eq(messageThreadAccess.reportId, reportId)))[0].n;
  assert.equal(await count(), 0);
  const opened = await openReportedThread({ operator: ops, reportId });
  assert.equal(opened.messages.at(-1)?.body, "Something reportable");
  await openReportedThread({ operator: ops, reportId });
  assert.equal(await count(), 2);

  await reviewReport({ operator: ops, reportId, outcome: "warned" });
  await assert.rejects(reviewReport({ operator: ops, reportId, outcome: "no_action" }), MessagingError);
});

test("a non-participant gets not-found", async () => {
  await assert.rejects(threadView(stranger, threadId), MessagingError);
  await assert.rejects(threadView(awayOps, threadId), MessagingError);
  await assert.rejects(sendMessage({ actor: stranger, threadId, body: "hi" }), MessagingError);
  assert.equal((await inboxFor(stranger)).length, 0);
});

test("the hourly send limit holds", async () => {
  await db.insert(message).values(
    Array.from({ length: SENDS_PER_HOUR }, (_, index) => ({
      institutionId: home.institutionId,
      threadId,
      senderSide: "tutor" as const,
      senderUserId: tutor.userId,
      body: `filler ${index}`,
    })),
  );
  await assert.rejects(sendMessage({ actor: tutor, threadId, body: "one too many" }), /a lot of messages/);
});

test("a deleted sender renders as Deleted user", async () => {
  await sendMessage({ actor: tutor, threadId, body: "From someone who leaves" });
  await db.update(message).set({ senderUserId: null }).where(eq(message.threadId, threadId));
  const view = await threadView(student, threadId);
  assert.equal(view.messages[0].senderName, DELETED_USER);
});

test("the preview is one line of about 80 characters", () => {
  assert.equal(previewLine("short\n\nnote"), "short note");
  const long = previewLine("x".repeat(200));
  assert.equal(long.length, 80);
  assert.ok(long.endsWith("…"));
});

async function requestId(actor: TutorActor): Promise<string> {
  const [row] = await db
    .select({ id: matchRequest.id })
    .from(matchRequest)
    .innerJoin(tutorCourse, eq(tutorCourse.id, matchRequest.tutorCourseId))
    .where(and(eq(matchRequest.studentProfileId, student.studentProfileId), eq(tutorCourse.tutorProfileId, actor.tutorProfileId)));
  return row.id;
}
