import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { eq, inArray } from "drizzle-orm";

import { db } from "@/server/db";
import { isLocalHost } from "@/server/db/local-host.mjs";
import {
  course,
  courseOffering,
  engagement,
  institution,
  matchRequest,
  sessionBooking,
  sessionRating,
  studentProfile,
  term,
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";

import { RENEWAL_PRIOR_BP, STAR_PRIOR_BP, posteriorBp, renewalPool } from "./posterior";
import { refreshScores } from "./stats";

const databaseHost = new URL(process.env.DATABASE_URL ?? "postgres://unset").hostname;
if (!isLocalHost(databaseHost)) {
  throw new Error(`Refusing to run tests against ${databaseHost}: point DATABASE_URL at a local database.`);
}

const run = randomUUID().slice(0, 8);
const made = { institutions: [] as string[], users: [] as string[] };

type Campus = Awaited<ReturnType<typeof campus>>;
let home: Campus;
let away: Campus;

async function campus(slug: string) {
  const [inst] = await db
    .insert(institution)
    .values({ name: `Test ${slug}`, slug: `stats-${slug}-${run}`, emailDomain: `${slug}-${run}.test`, timezone: "America/Chicago" })
    .returning({ id: institution.id });
  made.institutions.push(inst.id);
  const [termRow] = await db
    .insert(term)
    .values({ institutionId: inst.id, name: "Now", startsOn: "2026-08-20", endsOn: "2026-12-15" })
    .returning({ id: term.id });
  const offering = async (title: string) => {
    const [courseRow] = await db
      .insert(course)
      .values({ institutionId: inst.id, title, department: "TEST" })
      .returning({ id: course.id });
    const [row] = await db
      .insert(courseOffering)
      .values({ institutionId: inst.id, courseId: courseRow.id, termId: termRow.id, section: "001" })
      .returning({ id: courseOffering.id });
    return { courseId: courseRow.id, offeringId: row.id };
  };
  return { institutionId: inst.id, termId: termRow.id, a: await offering("STATS A"), b: await offering("STATS B") };
}

let people = 0;
async function newUser(institutionId: string) {
  const id = `test_stats_${run}_${(people += 1)}`;
  await db.insert(user).values({ id, name: id, email: `${id}@example.test`, emailVerified: true });
  made.users.push(id);
  return { id, institutionId };
}

async function student(where: Campus): Promise<string> {
  const person = await newUser(where.institutionId);
  const [row] = await db.insert(studentProfile).values({ userId: person.id, institutionId: where.institutionId }).returning({ id: studentProfile.id });
  return row.id;
}

async function claim(where: Campus, courseId: string, status: "active" | "pending_verification" = "active") {
  const person = await newUser(where.institutionId);
  const [profile] = await db.insert(tutorProfile).values({ userId: person.id, institutionId: where.institutionId }).returning({ id: tutorProfile.id });
  const [row] = await db
    .insert(tutorCourse)
    .values({ tutorProfileId: profile.id, institutionId: where.institutionId, courseId, takenTermId: where.termId, gradeEarned: "A", status })
    .returning({ id: tutorCourse.id });
  return row.id;
}

let bought = 0;
async function buy(
  where: Campus,
  offeringId: string,
  tutorCourseId: string,
  studentProfileId: string,
  outcome: "active" | "completed" | "guarantee_refunded" | "term_refunded",
  kind: "exam_anchored" | "through_final" | "top_up" = "exam_anchored",
) {
  const [row] = await db
    .insert(engagement)
    .values({
      institutionId: where.institutionId,
      studentProfileId,
      tutorCourseId,
      courseOfferingId: offeringId,
      kind,
      sessionsPurchased: 4,
      pricePaidMinor: 10_000,
      status: outcome === "guarantee_refunded" || outcome === "term_refunded" ? "refunded" : outcome,
      guaranteeUsed: outcome === "guarantee_refunded",
      createdAt: new Date(Date.UTC(2026, 8, 1) + (bought += 1) * 60_000),
    })
    .returning({ id: engagement.id });
  return row.id;
}

async function rate(where: Campus, offeringId: string, tutorCourseId: string, stars: number[], released: boolean, removed = false) {
  const studentProfileId = await student(where);
  const engagementId = await buy(where, offeringId, tutorCourseId, studentProfileId, "active");
  for (const value of stars) {
    const [session] = await db
      .insert(sessionBooking)
      .values({ engagementId, institutionId: where.institutionId, scheduledAt: new Date(), status: "completed" })
      .returning({ id: sessionBooking.id });
    await db.insert(sessionRating).values({
      institutionId: where.institutionId,
      sessionId: session.id,
      tutorCourseId,
      studentProfileId,
      stars: value,
      releasedAt: released ? new Date() : null,
      removedAt: removed ? new Date() : null,
    });
  }
  return engagementId;
}

async function fields(id: string) {
  const [row] = await db
    .select({
      scoreSampleCount: tutorCourse.scoreSampleCount,
      scorePosteriorMean: tutorCourse.scorePosteriorMean,
      renewalTrialCount: tutorCourse.renewalTrialCount,
      renewalPosteriorMean: tutorCourse.renewalPosteriorMean,
    })
    .from(tutorCourse)
    .where(eq(tutorCourse.id, id));
  return row;
}

const untouched = { scoreSampleCount: 0, scorePosteriorMean: null, renewalTrialCount: 0, renewalPosteriorMean: null };
const prior = { scoreSampleCount: 0, scorePosteriorMean: STAR_PRIOR_BP, renewalTrialCount: 0, renewalPosteriorMean: RENEWAL_PRIOR_BP };

let rated: string;
let renewing: string;
let pending: string;
let awayRated: string;

before(async () => {
  home = await campus("home");
  away = await campus("away");
  rated = await claim(home, home.a.courseId);
  renewing = await claim(home, home.b.courseId);
  pending = await claim(home, home.a.courseId, "pending_verification");
  awayRated = await claim(away, away.a.courseId);
});

after(async () => {
  const institutions = made.institutions;
  const courseIds = (await db.select({ id: course.id }).from(course).where(inArray(course.institutionId, institutions))).map((row) => row.id);
  await db.delete(sessionRating).where(inArray(sessionRating.institutionId, institutions));
  await db.delete(sessionBooking).where(inArray(sessionBooking.institutionId, institutions));
  await db.delete(matchRequest).where(inArray(matchRequest.institutionId, institutions));
  await db.delete(engagement).where(inArray(engagement.institutionId, institutions));
  await db.delete(tutorCourse).where(inArray(tutorCourse.courseId, courseIds));
  await db.delete(tutorProfile).where(inArray(tutorProfile.userId, made.users));
  await db.delete(studentProfile).where(inArray(studentProfile.userId, made.users));
  await db.delete(user).where(inArray(user.id, made.users));
  await db.delete(courseOffering).where(inArray(courseOffering.courseId, courseIds));
  await db.delete(course).where(inArray(course.id, courseIds));
  await db.delete(term).where(inArray(term.institutionId, institutions));
  await db.delete(institution).where(inArray(institution.id, institutions));
  await db.$client.end();
});

test("an active claim with no ratings and no trials gets both priors; a pending claim is left alone", async () => {
  await refreshScores(home.institutionId);
  assert.deepEqual(await fields(rated), prior);
  assert.deepEqual(await fields(renewing), prior);
  assert.deepEqual(await fields(pending), untouched);
});

test("unreleased ratings, open or closed, and removed ones change no score field", async () => {
  await rate(home, home.a.offeringId, rated, [1, 1, 1, 1, 1], false);
  await rate(home, home.a.offeringId, rated, [1, 1], true, true);
  assert.equal(await refreshScores(home.institutionId), 0);
  assert.deepEqual(await fields(rated), prior);
});

test("a released batch moves the star term, smoothed toward 4.0", async () => {
  await db.update(sessionRating).set({ releasedAt: new Date() }).where(eq(sessionRating.tutorCourseId, rated));
  await refreshScores(home.institutionId);
  assert.deepEqual(await fields(rated), { ...prior, scoreSampleCount: 5, scorePosteriorMean: 3_750 });
});

test("a renewal is a trial and a success; a lone historical guarantee refund fails unless the pair bought again; an active first package is no trial", async () => {
  const renewed = await student(home);
  await buy(home, home.b.offeringId, renewing, renewed, "completed");
  await buy(home, home.b.offeringId, renewing, renewed, "active");

  const refunded = await student(home);
  await buy(home, home.b.offeringId, renewing, refunded, "guarantee_refunded");

  const refundedThenBack = await student(home);
  await buy(home, home.b.offeringId, renewing, refundedThenBack, "guarantee_refunded");
  await buy(home, home.b.offeringId, renewing, refundedThenBack, "active");

  const stillGoing = await student(home);
  await buy(home, home.b.offeringId, renewing, stillGoing, "active");
  await buy(home, home.b.offeringId, renewing, stillGoing, "completed");

  await refreshScores(home.institutionId);
  assert.deepEqual(await fields(renewing), { ...prior, renewalTrialCount: 3, renewalPosteriorMean: 5_000 });
});

test("a first package refunded at term end with no session delivered is no trial, even if the pair bought again", async () => {
  const termEnd = await claim(home, home.b.courseId);
  const lapsed = await student(home);
  await buy(home, home.b.offeringId, termEnd, lapsed, "term_refunded");
  const lapsedThenBack = await student(home);
  await buy(home, home.b.offeringId, termEnd, lapsedThenBack, "term_refunded");
  await buy(home, home.b.offeringId, termEnd, lapsedThenBack, "active");
  const guaranteed = await student(home);
  await buy(home, home.b.offeringId, termEnd, guaranteed, "guarantee_refunded");

  await refreshScores(home.institutionId);
  assert.deepEqual(await fields(termEnd), { ...prior, renewalTrialCount: 1, renewalPosteriorMean: 3_333 });
});

test("a refill and a direct-renewal package each make the pair a success once; an accepted renewal never bought does not", async () => {
  const direct = await claim(home, home.b.courseId);

  const refilled = await student(home);
  await buy(home, home.b.offeringId, direct, refilled, "completed");
  await buy(home, home.b.offeringId, direct, refilled, "completed", "top_up");
  await buy(home, home.b.offeringId, direct, refilled, "active", "top_up");

  const renewed = await student(home);
  await buy(home, home.b.offeringId, direct, renewed, "completed");
  await buy(home, home.b.offeringId, direct, renewed, "active", "through_final");

  const askedOnly = await student(home);
  await buy(home, home.b.offeringId, direct, askedOnly, "completed");
  await db.insert(matchRequest).values({
    institutionId: home.institutionId,
    studentProfileId: askedOnly,
    tutorCourseId: direct,
    courseOfferingId: home.b.offeringId,
    status: "accepted",
    requestedKind: "through_final",
    expiresAt: new Date(),
  });

  await refreshScores(home.institutionId);
  assert.deepEqual(await fields(direct), {
    ...prior,
    renewalTrialCount: 3,
    renewalPosteriorMean: posteriorBp(renewalPool(3, 2), RENEWAL_PRIOR_BP),
  });
});

test("another campus is neither written nor counted toward this campus's prior", async () => {
  await rate(away, away.a.offeringId, awayRated, Array(25).fill(1), true);
  await refreshScores(home.institutionId);
  assert.deepEqual(await fields(awayRated), untouched);
  assert.equal((await fields(renewing)).scorePosteriorMean, STAR_PRIOR_BP);

  await refreshScores(away.institutionId);
  assert.deepEqual(await fields(awayRated), { ...prior, scoreSampleCount: 25, scorePosteriorMean: 0 });
});

test("a course with 20 released ratings becomes the prior for its own claims, and the campus for the rest", async () => {
  const twin = await claim(home, home.b.courseId);
  await rate(home, home.b.offeringId, twin, Array(20).fill(5), true);
  const fresh = await claim(home, home.a.courseId);
  await refreshScores(home.institutionId);

  assert.equal((await fields(twin)).scorePosteriorMean, 10_000);
  assert.equal((await fields(renewing)).scorePosteriorMean, 10_000);
  assert.equal((await fields(fresh)).scorePosteriorMean, 8_000);
  assert.equal((await fields(rated)).scorePosteriorMean, 4_000);
});

test("a re-run with nothing new writes nothing and changes nothing", async () => {
  const ids = [rated, renewing, pending, awayRated];
  const before = await Promise.all(ids.map(fields));
  assert.equal(await refreshScores(home.institutionId), 0);
  assert.equal(await refreshScores(away.institutionId), 0);
  assert.deepEqual(await Promise.all(ids.map(fields)), before);
});

test("overlapping refreshes agree", async () => {
  await db.update(tutorCourse).set({ scorePosteriorMean: null }).where(eq(tutorCourse.id, rated));
  const [first, second] = await Promise.all([refreshScores(home.institutionId), refreshScores(home.institutionId)]);
  assert.equal(first + second, 1);
  assert.equal((await fields(rated)).scorePosteriorMean, 4_000);
});
