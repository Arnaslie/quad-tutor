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
  tutorAvailability,
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";
import { confirmAttendance } from "@/server/modules/engagements/confirmation";
import { purchasePackage, slotsForRequest } from "@/server/modules/engagements/purchase";
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

import { rateSession, saveRating } from "./capture";
import { cardRatings, notesForTutor, sessionRatingState } from "./reads";
import { releaseRatings } from "./release";
import { WINDOW_DAYS } from "./rules";
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
  await db.insert(tutorAvailability).values(
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ tutorProfileId: profile.id, institutionId, weekday, startMinute: 8 * 60, endMinute: 20 * 60 })),
  );
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
      occurredAt: new Date(Date.now() - (params.recognisedDaysAgo ?? WINDOW_DAYS + 6) * 86_400_000),
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

async function engagementFor(tutorCourseId: string, courseOfferingId: string) {
  const [row] = await db
    .insert(engagement)
    .values({
      studentProfileId: student.studentProfileId,
      institutionId: home.institutionId,
      tutorCourseId,
      courseOfferingId,
      sessionsPurchased: 8,
      pricePaidMinor: 20_000,
      status: "active",
    })
    .returning({ id: engagement.id });
  return row;
}

const counts = async () => ({
  reliability: (await db.select({ n: sql<number>`count(*)::int` }).from(reliabilityEvent).where(inArray(reliabilityEvent.userId, made.users)))[0].n,
  ledger: (await db.select({ n: sql<number>`count(*)::int` }).from(ledgerEntry).where(eq(ledgerEntry.engagementId, engagementId)))[0].n,
});

const releaseStamps = async (id: string) =>
  (
    await db
      .select({
        released: sql<number>`count(${sessionRating.releasedAt})::int`,
        stamps: sql<number>`count(distinct ${sessionRating.releasedAt})::int`,
        pending: sql<number>`(count(*) filter (where ${sessionRating.releasedAt} is null))::int`,
      })
      .from(sessionRating)
      .where(eq(sessionRating.tutorCourseId, id))
  )[0];

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

  await requestTutors({ actor: student, courseOfferingId: home.a.offeringId, tutorCourseIds: [tutorCourseId], kind: "exam_anchored" });
  const [request] = await db
    .select({ id: matchRequest.id })
    .from(matchRequest)
    .where(and(eq(matchRequest.studentProfileId, student.studentProfileId), eq(matchRequest.tutorCourseId, tutorCourseId)));
  await acceptRequest({ tutor, requestId: request.id });
  ({ engagementId } = await purchasePackage({
    actor: student,
    requestId: request.id,
    anchorExamId: null,
    slotStartsAt: (await slotsForRequest({ actor: student, requestId: request.id }))[0],
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
  await db.delete(tutorAvailability).where(inArray(tutorAvailability.institutionId, institutions));
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

test("after the window the rating is fixed, and its note waits for a release", async () => {
  await ageRecognition(WINDOW_DAYS - 1);
  assert.equal((await sessionRatingState(student, sessionId))?.open, true);
  assert.deepEqual(await notesForTutor(tutor), []);

  await ageRecognition(2);
  await assert.rejects(rateSession({ actor: student, sessionId, stars: 1, note: null }), /closed/);
  const state = await sessionRatingState(student, sessionId);
  assert.equal(state?.open, false);
  assert.equal(state?.rating?.stars, 5);
  const [earned] = await db
    .select({ at: sql<string>`(min(${ledgerEntry.occurredAt}) + make_interval(days => ${WINDOW_DAYS}))::text` })
    .from(ledgerEntry)
    .where(and(eq(ledgerEntry.sessionId, sessionId), eq(ledgerEntry.type, "session_earned")));
  assert.equal(state?.closesAt.getTime(), new Date(earned.at).getTime());

  assert.equal(await releaseRatings(home.institutionId), 0);
  assert.deepEqual(await notesForTutor(tutor), [], "a closed note stays hidden until its batch releases");
});

test("the first 5 closed ratings release together, and the note reaches the tutor anonymously", async () => {
  const tcB = await claim(tutor, home.b.courseId);
  const b = await engagementFor(tcB, home.b.offeringId);

  await delivered({ engagementId, count: 3, rate: { tutorCourseId, stars: [4, 4, 5] } });
  await delivered({ engagementId: b.id, count: 4, rate: { tutorCourseId: tcB, stars: [2] } });
  assert.equal(await releaseRatings(home.institutionId), 0);
  const four = await cardRatings(home.institutionId, [tutorCourseId, tcB]);
  assert.deepEqual(four.get(tutorCourseId), { courseRating: null, overallRating: null }, "4 closed ratings");
  assert.deepEqual(four.get(tcB), { courseRating: null, overallRating: null });

  await delivered({ engagementId, count: 1, rate: { tutorCourseId, stars: [3] } });
  const unreleased = await cardRatings(home.institutionId, [tutorCourseId]);
  assert.deepEqual(unreleased.get(tutorCourseId), { courseRating: null, overallRating: null }, "closed is not enough");
  assert.deepEqual(await notesForTutor(tutor), []);

  assert.equal(await releaseRatings(home.institutionId), 5);
  assert.deepEqual(await releaseStamps(tutorCourseId), { released: 5, stamps: 1, pending: 0 });
  const nine = await cardRatings(home.institutionId, [tutorCourseId]);
  assert.deepEqual(nine.get(tutorCourseId), { courseRating: null, overallRating: null }, "9 sessions, 5 released ratings");

  await delivered({ engagementId: b.id, count: 1 });
  const rated = await cardRatings(home.institutionId, [tutorCourseId, tcB]);
  const publicA = { average: "4.2", count: 5 };
  assert.deepEqual(rated.get(tutorCourseId), { courseRating: publicA, overallRating: publicA }, "B's lone rating stays out of overall");
  assert.deepEqual(rated.get(tcB), { courseRating: null, overallRating: publicA });
  assert.equal(await releaseRatings(home.institutionId), 0, "a re-run releases nothing");

  const notes = await notesForTutor(tutor);
  assert.equal(notes.length, 1);
  assert.deepEqual(Object.keys(notes[0]).sort(), ["courseLabel", "note", "ratingId", "reported"]);
  assert.equal(notes[0].note, "Went over the old exams.");
  assert.equal(notes[0].reported, false);
  assert.deepEqual(await notesForTutor(otherTutor), []);

  assert.equal((await cardRatings(away.institutionId, [tutorCourseId])).size, 0, "no read across campuses");
});

test("after the first release, ratings release in batches of 3, and an open-window rating never does", async () => {
  const publicA = { average: "4.2", count: 5 };
  await delivered({ engagementId, count: 1, rate: { tutorCourseId, stars: [1] }, recognisedDaysAgo: WINDOW_DAYS - 4 });
  await delivered({ engagementId, count: 1, rate: { tutorCourseId, stars: [1] } });
  assert.equal(await releaseRatings(home.institutionId), 0);
  await delivered({ engagementId, count: 1, rate: { tutorCourseId, stars: [1] } });
  assert.equal(await releaseRatings(home.institutionId), 0);
  const two = await cardRatings(home.institutionId, [tutorCourseId]);
  assert.deepEqual(two.get(tutorCourseId), { courseRating: publicA, overallRating: publicA }, "1 or 2 closed ratings change nothing");

  await delivered({ engagementId, count: 1, rate: { tutorCourseId, stars: [1] } });
  assert.equal(await releaseRatings(home.institutionId), 3);
  assert.deepEqual(await releaseStamps(tutorCourseId), { released: 8, stamps: 2, pending: 1 });
  const eight = { average: "3.0", count: 8 };
  assert.deepEqual((await cardRatings(home.institutionId, [tutorCourseId])).get(tutorCourseId), { courseRating: eight, overallRating: eight });
  assert.equal(await releaseRatings(home.institutionId), 0, "the open-window rating stays unreleased");
});

test("open-window ratings stay out of the course count but their sessions count, and overall sums every public course", async () => {
  const edge = await tutorFor("edge-tutor", home.institutionId);
  const tcA = await claim(edge, home.a.courseId);
  const tcB = await claim(edge, home.b.courseId);
  const a = await engagementFor(tcA, home.a.offeringId);
  const b = await engagementFor(tcB, home.b.offeringId);

  await delivered({ engagementId: a.id, count: 4, rate: { tutorCourseId: tcA, stars: [5, 5, 4, 4] } });
  await delivered({ engagementId: a.id, count: 1, rate: { tutorCourseId: tcA, stars: [1] }, recognisedDaysAgo: 1 });
  await delivered({ engagementId: b.id, count: 5, rate: { tutorCourseId: tcB, stars: [3, 3, 3, 3, 3] } });
  assert.equal(await releaseRatings(home.institutionId), 5);

  const gated = await cardRatings(home.institutionId, [tcA, tcB]);
  const publicB = { average: "3.0", count: 5 };
  assert.deepEqual(gated.get(tcA), { courseRating: null, overallRating: publicB }, "4 closed and 1 open rating; 9 closed and 1 open session");
  assert.deepEqual(gated.get(tcB), { courseRating: publicB, overallRating: publicB });

  await delivered({ engagementId: a.id, count: 1, rate: { tutorCourseId: tcA, stars: [4] } });
  assert.equal(await releaseRatings(home.institutionId), 5);
  const both = await cardRatings(home.institutionId, [tcA, tcB]);
  const overall = { average: "3.7", count: 10 };
  assert.deepEqual(both.get(tcA), { courseRating: { average: "4.4", count: 5 }, overallRating: overall });
  assert.deepEqual(both.get(tcB), { courseRating: publicB, overallRating: overall });
});

test("overlapping sweeps release a batch once and don't error", async () => {
  const racer = await tutorFor("race-tutor", home.institutionId);
  const tc = await claim(racer, home.a.courseId);
  const e = await engagementFor(tc, home.a.offeringId);
  await delivered({ engagementId: e.id, count: 5, rate: { tutorCourseId: tc, stars: [5, 4, 3, 2, 1] } });

  const runs = await Promise.all(Array.from({ length: 4 }, () => releaseRatings(home.institutionId)));
  assert.equal(runs.reduce((sum, n) => sum + n, 0), 5);
  assert.deepEqual(await releaseStamps(tc), { released: 5, stamps: 1, pending: 0 });
  assert.equal(await releaseRatings(home.institutionId), 0);
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
  assert.equal(ratingReport.ratingNote, null, "the queue never carries rating content");
  assert.equal(ratingReport.ratingStars, null);
  assert.equal(ratingReport.tutorName, "tutor");
  assert.equal(threadReport.threadId, threadId);

  await assert.rejects(openReportedThread({ operator: ops, reportId: ratingReport.id }), MessagingError);
  await assert.rejects(openReportedRating({ operator: awayOps, reportId: ratingReport.id }), MessagingError);
  const audits = async () =>
    (await db.select({ n: sql<number>`count(*)::int` }).from(sessionRatingAccess).where(eq(sessionRatingAccess.reportId, ratingReport.id)))[0].n;
  await assert.rejects(openReportedRating({ operator: ops, reportId: threadReport.id }), MessagingError);
  const allAudits = async () =>
    (await db.select({ n: sql<number>`count(*)::int` }).from(sessionRatingAccess).where(eq(sessionRatingAccess.institutionId, home.institutionId)))[0].n;
  assert.equal(await allAudits(), 0, "a refused open writes no audit row");
  assert.equal(await audits(), 0);
  const opened = await openReportedRating({ operator: ops, reportId: ratingReport.id });
  assert.equal(opened.sessionRatingId, note.ratingId);
  assert.equal(opened.ratingNote, "Went over the old exams.");
  assert.equal(opened.ratingStars, 5);
  const [audit] = await db.select().from(sessionRatingAccess).where(eq(sessionRatingAccess.reportId, ratingReport.id));
  assert.equal(audit.operatorUserId, ops.userId);
  assert.equal(audit.sessionRatingId, note.ratingId);
  assert.equal(audit.institutionId, home.institutionId);
  assert.equal(await audits(), 1);
  assert.equal((await openReportedThread({ operator: ops, reportId: threadReport.id })).report.id, threadReport.id);

  await assert.rejects(reviewReport({ operator: ops, reportId: threadReport.id, outcome: "removed" }), /Only a rating/);
  await reviewReport({ operator: ops, reportId: threadReport.id, outcome: "warned" });

  const beforeRemoval = (await cardRatings(home.institutionId, [tutorCourseId])).get(tutorCourseId);
  assert.equal(beforeRemoval?.overallRating?.count, 8);

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
  const seven = { average: "2.7", count: 7 };
  assert.deepEqual(afterRemoval, { courseRating: seven, overallRating: seven }, "removal leaves at once, without a release");
  assert.deepEqual(await notesForTutor(tutor), []);
  assert.equal((await sessionRatingState(student, sessionId))?.rating, null);
  await assert.rejects(rateSession({ actor: student, sessionId, stars: 5, note: null }), /removed/);
});

const ENDED_AGO = WINDOW_DAYS + 2;

async function dbDate(daysAgo: number): Promise<string> {
  const [row] = await db.select({ day: sql<string>`(current_date - ${daysAgo}::int)::text` }).from(institution).limit(1);
  return row.day;
}

async function pastOffering(endedDaysAgo = ENDED_AGO): Promise<string> {
  const [past] = await db
    .insert(term)
    .values({ institutionId: home.institutionId, name: `Past ${randomUUID().slice(0, 6)}`, startsOn: inDays(-150), endsOn: await dbDate(endedDaysAgo) })
    .returning({ id: term.id });
  const [row] = await db
    .insert(courseOffering)
    .values({ institutionId: home.institutionId, courseId: home.a.courseId, termId: past.id, section: "001" })
    .returning({ id: courseOffering.id });
  return row.id;
}

async function termEndPool(key: string, endedDaysAgo?: number) {
  const owner = await tutorFor(key, home.institutionId);
  const tc = await claim(owner, home.a.courseId);
  const endedOffering = await pastOffering(endedDaysAgo);
  return { tc, endedOffering, ended: await engagementFor(tc, endedOffering), current: await engagementFor(tc, home.a.offeringId) };
}

test("at term end a leftover pool of 2 is released, and a pool of 1 is not", async () => {
  const two = await termEndPool("term-two");
  await delivered({ engagementId: two.ended.id, count: 2, rate: { tutorCourseId: two.tc, stars: [4, 2] } });
  const one = await termEndPool("term-one");
  await delivered({ engagementId: one.ended.id, count: 1, rate: { tutorCourseId: one.tc, stars: [3] } });

  assert.equal(await releaseRatings(home.institutionId), 2);
  assert.deepEqual(await releaseStamps(two.tc), { released: 2, stamps: 1, pending: 0 });
  assert.deepEqual(await releaseStamps(one.tc), { released: 0, stamps: 0, pending: 1 });
});

test("a pool in a running term, or mixing an ended and a running term, follows the batch rule only", async () => {
  const running = await termEndPool("term-running");
  await delivered({ engagementId: running.current.id, count: 2, rate: { tutorCourseId: running.tc, stars: [5, 5] } });
  const mixed = await termEndPool("term-mixed");
  await delivered({ engagementId: mixed.ended.id, count: 1, rate: { tutorCourseId: mixed.tc, stars: [1] } });
  await delivered({ engagementId: mixed.current.id, count: 1, rate: { tutorCourseId: mixed.tc, stars: [5] } });

  assert.equal(await releaseRatings(home.institutionId), 0);
  assert.deepEqual(await releaseStamps(running.tc), { released: 0, stamps: 0, pending: 2 });
  assert.deepEqual(await releaseStamps(mixed.tc), { released: 0, stamps: 0, pending: 2 });

  await delivered({ engagementId: mixed.current.id, count: 3, rate: { tutorCourseId: mixed.tc, stars: [4, 4, 4] } });
  assert.equal(await releaseRatings(home.institutionId), 5);
  assert.deepEqual(await releaseStamps(mixed.tc), { released: 5, stamps: 1, pending: 0 });
});

async function closedPool(key: string, count: number, recognisedDaysAgo?: number) {
  const owner = await tutorFor(key, home.institutionId);
  const tc = await claim(owner, home.a.courseId);
  const e = await engagementFor(tc, home.a.offeringId);
  await delivered({ engagementId: e.id, count, rate: { tutorCourseId: tc, stars: Array(count).fill(2) }, recognisedDaysAgo });
  const rows = await db.select().from(sessionRating).where(eq(sessionRating.tutorCourseId, tc));
  return { owner, tc, rows };
}

test("an edit can't overwrite a released rating, even inside its window", async () => {
  const { rows } = await closedPool("edit-race", 1, 1);
  await db.update(sessionRating).set({ releasedAt: sql`now()` }).where(eq(sessionRating.id, rows[0].id));
  await assert.rejects(rateSession({ actor: student, sessionId: rows[0].sessionId, stars: 5, note: "changed" }), /closed or was removed/);
  const [after] = await db.select().from(sessionRating).where(eq(sessionRating.id, rows[0].id));
  assert.equal(after.stars, 2);
  assert.equal(after.note, null);
});

test("a tutor can't report a closed note before it is released", async () => {
  const { owner, rows } = await closedPool("report-early", 1);
  await db.update(sessionRating).set({ note: "Too early to see" }).where(eq(sessionRating.id, rows[0].id));
  await assert.rejects(reportRating({ actor: owner, sessionRatingId: rows[0].id, reason: "spam", note: null }), /does not exist/);
});

test("a sweep for one campus leaves another campus's ratings alone", async () => {
  const { tc } = await closedPool("away-sweep", 5);
  assert.equal(await releaseRatings(away.institutionId), 0);
  assert.deepEqual(await releaseStamps(tc), { released: 0, stamps: 0, pending: 5 });
  assert.equal(await releaseRatings(home.institutionId), 5);
});

test("a term-end pool waits until the term's rating window has passed, then releases whole", async () => {
  const pool = await termEndPool("term-straggler", 2);
  await delivered({ engagementId: pool.ended.id, count: 2, rate: { tutorCourseId: pool.tc, stars: [5, 1] } });
  await delivered({ engagementId: pool.ended.id, count: 1, rate: { tutorCourseId: pool.tc, stars: [3] }, recognisedDaysAgo: 1 });
  assert.equal(await releaseRatings(home.institutionId), 0, "2 closed and 1 open in a term ended 2 days ago");
  assert.deepEqual(await releaseStamps(pool.tc), { released: 0, stamps: 0, pending: 3 });

  const [offering] = await db.select({ termId: courseOffering.termId }).from(courseOffering).where(eq(courseOffering.id, pool.endedOffering));
  await db.update(term).set({ endsOn: await dbDate(ENDED_AGO) }).where(eq(term.id, offering.termId));
  await db
    .update(ledgerEntry)
    .set({ occurredAt: new Date(Date.now() - (WINDOW_DAYS + 1) * 86_400_000) })
    .where(eq(ledgerEntry.engagementId, pool.ended.id));
  assert.equal(await releaseRatings(home.institutionId), 3);
  assert.deepEqual(await releaseStamps(pool.tc), { released: 3, stamps: 1, pending: 0 });
});

test("a term ending today, or exactly a window and a day ago, holds its pool", async () => {
  const today = await termEndPool("term-today", 0);
  await delivered({ engagementId: today.ended.id, count: 2, rate: { tutorCourseId: today.tc, stars: [4, 4] } });
  const edge = await termEndPool("term-edge", WINDOW_DAYS + 1);
  await delivered({ engagementId: edge.ended.id, count: 2, rate: { tutorCourseId: edge.tc, stars: [4, 4] } });
  assert.equal(await releaseRatings(home.institutionId), 0);
  assert.deepEqual(await releaseStamps(today.tc), { released: 0, stamps: 0, pending: 2 });
  assert.deepEqual(await releaseStamps(edge.tc), { released: 0, stamps: 0, pending: 2 });
});

test("the upsert itself refuses an edit once the window has closed", async () => {
  const { rows } = await closedPool("window-sql", 1);
  const [row] = rows;
  const { institutionId, sessionId: rated, tutorCourseId: tc, studentProfileId } = row;
  const saved = await saveRating({ institutionId, sessionId: rated, tutorCourseId: tc, studentProfileId, stars: 5, note: "late edit" });
  assert.equal(saved.length, 0);
  const [after] = await db.select().from(sessionRating).where(eq(sessionRating.id, row.id));
  assert.deepEqual([after.stars, after.note], [2, null]);
});
