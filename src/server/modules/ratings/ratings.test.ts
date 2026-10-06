import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { isLocalHost } from "@/server/db/local-host.mjs";
import {
  course,
  courseCodeAlias,
  courseOffering,
  engagement,
  institution,
  ledgerEntry,
  matchRequest,
  message,
  messageReport,
  messageThread,
  messageThreadAccess,
  operator,
  reliabilityEvent,
  sessionBooking,
  sessionRating,
  sessionRatingAccess,
  studentProfile,
  term,
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";
import { confirmAttendance } from "@/server/modules/engagements/confirmation";
import { purchasePackage } from "@/server/modules/engagements/purchase";
import type { Actor, OperatorActor, TutorActor } from "@/server/modules/identity/actor";
import { acceptRequest, requestTutors } from "@/server/modules/matching/requests";
import {
  openReportedRating,
  openReportedThread,
  reportRating,
  reportThread,
  reportsForOperator,
  reviewReport,
} from "@/server/modules/messaging/reports";
import { MessagingError } from "@/server/modules/messaging/threads";

import { rateSession } from "./capture";
import { cardRatings, notesForTutor, sessionRatingState } from "./reads";
import { RatingError } from "./window";

const databaseHost = new URL(process.env.DATABASE_URL ?? "postgres://unset").hostname;
if (!isLocalHost(databaseHost)) {
  throw new Error(`Refusing to run tests against ${databaseHost}: point DATABASE_URL at a local database.`);
}

delete process.env.RESEND_API_KEY;
const log = console.log;
console.log = (...args: unknown[]) => {
  const line = String(args[0] ?? "");
  if (!line.startsWith("[email]") && !line.startsWith("\n[email]")) log(...args);
};

const run = randomUUID().slice(0, 8);
const made = { institutions: [] as string[], users: [] as string[] };

let home: Awaited<ReturnType<typeof campus>>;
let away: Awaited<ReturnType<typeof campus>>;
let student: Actor;
let stranger: Actor;
let tutor: TutorActor;
let otherTutor: TutorActor;
let ops: OperatorActor;
let awayOps: OperatorActor;
let tutorCourseId: string;
let engagementId: string;
let sessionId: string;
let threadId: string;

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function campus(slug: string) {
  const [inst] = await db
    .insert(institution)
    .values({ name: `Test ${slug}`, slug: `rate-${slug}-${run}`, emailDomain: `${slug}-${run}.test`, timezone: "America/Chicago" })
    .returning({ id: institution.id });
  made.institutions.push(inst.id);
  const [termRow] = await db
    .insert(term)
    .values({ institutionId: inst.id, name: "Now", startsOn: inDays(-90), endsOn: inDays(30) })
    .returning({ id: term.id });
  const offering = async (title: string) => {
    const [courseRow] = await db
      .insert(course)
      .values({ institutionId: inst.id, title, department: "TEST" })
      .returning({ id: course.id });
    await db.insert(courseCodeAlias).values({ institutionId: inst.id, courseId: courseRow.id, code: `${title} ${run}` });
    const [row] = await db
      .insert(courseOffering)
      .values({ institutionId: inst.id, courseId: courseRow.id, termId: termRow.id, section: "001" })
      .returning({ id: courseOffering.id });
    return { courseId: courseRow.id, offeringId: row.id };
  };
  return { institutionId: inst.id, termId: termRow.id, a: await offering("RATE A"), b: await offering("RATE B") };
}

async function person(key: string, institutionId: string): Promise<Actor> {
  const id = `test_rate_${key}_${run}`;
  await db.insert(user).values({ id, name: key, email: `${id}@example.test`, emailVerified: true });
  made.users.push(id);
  const [profile] = await db.insert(studentProfile).values({ userId: id, institutionId }).returning({ id: studentProfile.id });
  return { userId: id, name: key, email: `${id}@example.test`, institutionId, studentProfileId: profile.id, tutorProfileId: null };
}

async function tutorFor(key: string, institutionId: string): Promise<TutorActor> {
  const base = await person(key, institutionId);
  const [profile] = await db.insert(tutorProfile).values({ userId: base.userId, institutionId }).returning({ id: tutorProfile.id });
  return { ...base, tutorProfileId: profile.id };
}

async function claim(actor: TutorActor, courseId: string): Promise<string> {
  const [row] = await db
    .insert(tutorCourse)
    .values({ tutorProfileId: actor.tutorProfileId, institutionId: actor.institutionId, courseId, takenTermId: home.termId, gradeEarned: "A", status: "active" })
    .returning({ id: tutorCourse.id });
  return row.id;
}

async function operatorFor(key: string, institutionId: string): Promise<OperatorActor> {
  const base = await person(key, institutionId);
  await db.insert(operator).values({ userId: base.userId, institutionId });
  return { ...base, operatorInstitutionIds: [institutionId] };
}

async function delivered(params: {
  engagementId: string;
  count: number;
  rate?: { tutorCourseId: string; stars: number[] };
  recognisedDaysAgo?: number;
}) {
  for (let index = 0; index < params.count; index += 1) {
    const [session] = await db
      .insert(sessionBooking)
      .values({
        engagementId: params.engagementId,
        institutionId: home.institutionId,
        scheduledAt: new Date(Date.now() - (index + 2) * 86_400_000),
        status: "completed",
        resolution: "both_confirmed",
      })
      .returning({ id: sessionBooking.id });
    await db.insert(ledgerEntry).values({
      engagementId: params.engagementId,
      institutionId: home.institutionId,
      sessionId: session.id,
      type: "session_earned",
      amountMinor: 2500,
      occurredAt: new Date(Date.now() - (params.recognisedDaysAgo ?? 20) * 86_400_000),
    });
    const stars = params.rate?.stars[index];
    if (params.rate && stars) {
      await db.insert(sessionRating).values({
        institutionId: home.institutionId,
        sessionId: session.id,
        tutorCourseId: params.rate.tutorCourseId,
        studentProfileId: student.studentProfileId,
        stars,
      });
    }
  }
}

async function ageRecognition(days: number) {
  await db
    .update(ledgerEntry)
    .set({ occurredAt: sql`${ledgerEntry.occurredAt} - make_interval(days => ${days})` })
    .where(eq(ledgerEntry.sessionId, sessionId));
}

const counts = async () => ({
  reliability: (await db.select({ n: sql<number>`count(*)::int` }).from(reliabilityEvent).where(inArray(reliabilityEvent.userId, made.users)))[0].n,
  ledger: (await db.select({ n: sql<number>`count(*)::int` }).from(ledgerEntry).where(eq(ledgerEntry.engagementId, engagementId)))[0].n,
});

before(async () => {
  home = await campus("home");
  away = await campus("away");
  student = await person("student", home.institutionId);
  stranger = await person("stranger", home.institutionId);
  tutor = await tutorFor("tutor", home.institutionId);
  otherTutor = await tutorFor("other-tutor", home.institutionId);
  ops = await operatorFor("ops", home.institutionId);
  awayOps = await operatorFor("away-ops", away.institutionId);
  tutorCourseId = await claim(tutor, home.a.courseId);
  await claim(otherTutor, home.a.courseId);

  await requestTutors({ actor: student, courseOfferingId: home.a.offeringId, tutorCourseIds: [tutorCourseId] });
  const [request] = await db
    .select({ id: matchRequest.id })
    .from(matchRequest)
    .where(and(eq(matchRequest.studentProfileId, student.studentProfileId), eq(matchRequest.tutorCourseId, tutorCourseId)));
  await acceptRequest({ tutor, requestId: request.id });
  ({ engagementId } = await purchasePackage({
    actor: student,
    requestId: request.id,
    kind: "exam_anchored",
    anchorExamId: null,
    slotStartsAt: new Date(Date.now() + 3 * 86_400_000),
  }));
  const [session] = await db.select({ id: sessionBooking.id }).from(sessionBooking).where(eq(sessionBooking.engagementId, engagementId));
  sessionId = session.id;
  const [thread] = await db.select({ id: messageThread.id }).from(messageThread).where(eq(messageThread.tutorCourseId, tutorCourseId));
  threadId = thread.id;
});

after(async () => {
  console.log = log;
  const institutions = made.institutions;
  const ratings = (await db.select({ id: sessionRating.id }).from(sessionRating).where(inArray(sessionRating.institutionId, institutions))).map((row) => row.id);
  const threads = (await db.select({ id: messageThread.id }).from(messageThread).where(inArray(messageThread.institutionId, institutions))).map((row) => row.id);
  const engagements = (await db.select({ id: engagement.id }).from(engagement).where(inArray(engagement.institutionId, institutions))).map((row) => row.id);
  const courseIds = (await db.select({ id: course.id }).from(course).where(inArray(course.institutionId, institutions))).map((row) => row.id);

  await db.delete(messageThreadAccess).where(inArray(messageThreadAccess.institutionId, institutions));
  await db.delete(sessionRatingAccess).where(inArray(sessionRatingAccess.institutionId, institutions));
  await db.delete(messageReport).where(inArray(messageReport.institutionId, institutions));
  if (ratings.length) await db.delete(sessionRating).where(inArray(sessionRating.id, ratings));
  if (threads.length) {
    await db.delete(message).where(inArray(message.threadId, threads));
    await db.delete(messageThread).where(inArray(messageThread.id, threads));
  }
  await db.delete(reliabilityEvent).where(inArray(reliabilityEvent.userId, made.users));
  if (engagements.length) {
    await db.delete(ledgerEntry).where(inArray(ledgerEntry.engagementId, engagements));
    await db.delete(sessionBooking).where(inArray(sessionBooking.engagementId, engagements));
    await db.delete(engagement).where(inArray(engagement.id, engagements));
  }
  await db.delete(matchRequest).where(eq(matchRequest.courseOfferingId, home.a.offeringId));
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

test("an uncompleted session can't be rated", async () => {
  await assert.rejects(rateSession({ actor: student, sessionId, stars: 5, note: null }), /took place/);
  assert.equal(await sessionRatingState(student, sessionId), null);
});

test("a completed session is rated, and edited inside the window, without a reliability or ledger write", async () => {
  await db
    .update(sessionBooking)
    .set({ scheduledAt: new Date(Date.now() - 2 * 3_600_000), confirmationWindowEndsAt: new Date(Date.now() + 22 * 3_600_000) })
    .where(eq(sessionBooking.id, sessionId));
  await confirmAttendance({ actor: student, sessionId });
  const settled = await confirmAttendance({ actor: tutor, sessionId });
  assert.equal(settled.status, "completed");

  const before = await counts();
  await rateSession({ actor: student, sessionId, stars: 3, note: "  Explained the curve well.  " });
  const first = await sessionRatingState(student, sessionId);
  assert.equal(first?.open, true);
  assert.deepEqual(first?.rating, { stars: 3, note: "Explained the curve well." });

  await rateSession({ actor: student, sessionId, stars: 5, note: "Went over the old exams." });
  const edited = await sessionRatingState(student, sessionId);
  assert.deepEqual(edited?.rating, { stars: 5, note: "Went over the old exams." });
  assert.equal((await db.select().from(sessionRating).where(eq(sessionRating.sessionId, sessionId))).length, 1);
  assert.deepEqual(await counts(), before);

  await assert.rejects(rateSession({ actor: student, sessionId, stars: 6, note: null }), RatingError);
  await assert.rejects(rateSession({ actor: student, sessionId, stars: 4, note: "x".repeat(281) }), RatingError);
  assert.deepEqual(await notesForTutor(tutor), [], "a note stays hidden while its window is open");
});

test("a non-owner can't rate, or see the rating", async () => {
  await assert.rejects(rateSession({ actor: stranger, sessionId, stars: 1, note: null }), /not yours/);
  await assert.rejects(rateSession({ actor: tutor, sessionId, stars: 5, note: null }), /not yours/);
  await assert.rejects(rateSession({ actor: { ...student, institutionId: away.institutionId }, sessionId, stars: 1, note: null }), /not yours/);
  assert.equal(await sessionRatingState(tutor, sessionId), null);
  assert.equal(await sessionRatingState(stranger, sessionId), null);
});

test("after 14 days the rating is fixed and the note reaches the tutor, anonymously", async () => {
  await ageRecognition(15);
  await assert.rejects(rateSession({ actor: student, sessionId, stars: 1, note: null }), /closed/);
  const state = await sessionRatingState(student, sessionId);
  assert.equal(state?.open, false);
  assert.equal(state?.rating?.stars, 5);
  const [earned] = await db
    .select({ at: sql<string>`(min(${ledgerEntry.occurredAt}) + interval '14 days')::text` })
    .from(ledgerEntry)
    .where(and(eq(ledgerEntry.sessionId, sessionId), eq(ledgerEntry.type, "session_earned")));
  assert.equal(state?.closesAt.getTime(), new Date(earned.at).getTime());

  const notes = await notesForTutor(tutor);
  assert.equal(notes.length, 1);
  assert.deepEqual(Object.keys(notes[0]).sort(), ["courseLabel", "note", "ratingId", "reported"]);
  assert.equal(notes[0].note, "Went over the old exams.");
  assert.equal(notes[0].reported, false);
  assert.deepEqual(await notesForTutor(otherTutor), []);
});

test("card ratings stay null below each threshold and are numbers above it", async () => {
  const tcB = await claim(tutor, home.b.courseId);
  const [b] = await db
    .insert(engagement)
    .values({
      studentProfileId: student.studentProfileId,
      institutionId: home.institutionId,
      tutorCourseId: tcB,
      courseOfferingId: home.b.offeringId,
      sessionsPurchased: 8,
      pricePaidMinor: 20_000,
      status: "active",
    })
    .returning({ id: engagement.id });

  await delivered({ engagementId, count: 3, rate: { tutorCourseId, stars: [4, 4, 5] } });
  await delivered({ engagementId: b.id, count: 5, rate: { tutorCourseId: tcB, stars: [2] } });

  const nine = await cardRatings(home.institutionId, [tutorCourseId, tcB]);
  assert.deepEqual(nine.get(tutorCourseId), { courseRating: null, overallRating: null }, "9 sessions, 5 ratings");

  await delivered({ engagementId: b.id, count: 1 });
  const ten = await cardRatings(home.institutionId, [tutorCourseId, tcB]);
  assert.deepEqual(ten.get(tutorCourseId), { courseRating: null, overallRating: null }, "4 and 1 course ratings");
  assert.deepEqual(ten.get(tcB), { courseRating: null, overallRating: null });

  await delivered({ engagementId, count: 1, rate: { tutorCourseId, stars: [3] } });
  const rated = await cardRatings(home.institutionId, [tutorCourseId, tcB]);
  const publicA = { average: "4.2", count: 5 };
  assert.deepEqual(rated.get(tutorCourseId), { courseRating: publicA, overallRating: publicA }, "B's lone rating stays out of overall");
  assert.deepEqual(rated.get(tcB), { courseRating: null, overallRating: publicA });

  await delivered({ engagementId, count: 1, rate: { tutorCourseId, stars: [1] }, recognisedDaysAgo: 3 });
  const inWindow = await cardRatings(home.institutionId, [tutorCourseId]);
  assert.deepEqual(inWindow.get(tutorCourseId), { courseRating: publicA, overallRating: publicA }, "an open-window rating is not counted");

  assert.equal((await cardRatings(away.institutionId, [tutorCourseId])).size, 0, "no read across campuses");
});

test("a reported rating is reviewed beside thread reports, and removal takes it out of every aggregate", async () => {
  const [note] = await notesForTutor(tutor);
  await assert.rejects(reportRating({ actor: otherTutor, sessionRatingId: note.ratingId, reason: "harassment", note: null }), MessagingError);
  await reportRating({ actor: tutor, sessionRatingId: note.ratingId, reason: "harassment", note: "Not about the session" });
  assert.equal((await notesForTutor(tutor))[0].reported, true);
  await assert.rejects(
    reportRating({ actor: tutor, sessionRatingId: note.ratingId, reason: "spam", note: null }),
    /already reported/,
  );

  await reportThread({ actor: student, threadId, reason: "spam", note: null });

  const queue = await reportsForOperator(ops);
  assert.equal((await reportsForOperator(awayOps)).length, 0);
  const ratingReport = queue.find((item) => item.subject === "rating")!;
  const threadReport = queue.find((item) => item.subject === "thread")!;
  assert.equal(ratingReport.ratingNote, "Went over the old exams.");
  assert.equal(ratingReport.tutorName, "tutor");
  assert.equal(threadReport.threadId, threadId);

  await assert.rejects(openReportedThread({ operator: ops, reportId: ratingReport.id }), MessagingError);
  await assert.rejects(openReportedRating({ operator: awayOps, reportId: ratingReport.id }), MessagingError);
  const audits = async () =>
    (await db.select({ n: sql<number>`count(*)::int` }).from(sessionRatingAccess).where(eq(sessionRatingAccess.reportId, ratingReport.id)))[0].n;
  assert.equal(await audits(), 0, "a refused open writes no audit row");
  assert.equal((await openReportedRating({ operator: ops, reportId: ratingReport.id })).sessionRatingId, note.ratingId);
  const [audit] = await db.select().from(sessionRatingAccess).where(eq(sessionRatingAccess.reportId, ratingReport.id));
  assert.equal(audit.operatorUserId, ops.userId);
  assert.equal(audit.sessionRatingId, note.ratingId);
  assert.equal(audit.institutionId, home.institutionId);
  assert.equal(await audits(), 1);
  assert.equal((await openReportedThread({ operator: ops, reportId: threadReport.id })).report.id, threadReport.id);

  await assert.rejects(reviewReport({ operator: ops, reportId: threadReport.id, outcome: "removed" }), /Only a rating/);
  await reviewReport({ operator: ops, reportId: threadReport.id, outcome: "warned" });

  const beforeRemoval = (await cardRatings(home.institutionId, [tutorCourseId])).get(tutorCourseId);
  assert.equal(beforeRemoval?.overallRating?.count, 5);

  await assert.rejects(reviewReport({ operator: awayOps, reportId: ratingReport.id, outcome: "removed" }), MessagingError);
  await reviewReport({ operator: ops, reportId: ratingReport.id, outcome: "removed" });

  const [row] = await db.select().from(sessionRating).where(eq(sessionRating.id, note.ratingId));
  assert.ok(row.removedAt);
  assert.equal(row.removedByUserId, ops.userId);
  const open = await db
    .select({ id: messageReport.id })
    .from(messageReport)
    .where(and(eq(messageReport.sessionRatingId, note.ratingId), sql`${messageReport.reviewedAt} is null`));
  assert.equal(open.length, 0);

  const afterRemoval = (await cardRatings(home.institutionId, [tutorCourseId])).get(tutorCourseId);
  assert.deepEqual(afterRemoval, { courseRating: null, overallRating: null });
  assert.deepEqual(await notesForTutor(tutor), []);
  assert.equal((await sessionRatingState(student, sessionId))?.rating, null);
  await assert.rejects(rateSession({ actor: student, sessionId, stars: 5, note: null }), /removed/);
});
