import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "../index";
import { course, courseCodeAlias, courseOffering, engagement, institution, ledgerEntry, matchRequest, messageThread, term, tutorCourse } from "../schema";
import { actorFor, tutorActorFor } from "../scenarios/people";

import { assertMoneyInvariants } from "@/server/modules/billing/invariants";
import { offeringsForCourse } from "@/server/modules/catalog/courses";
import { buyPackage, buyTopUp } from "@/server/modules/engagements/buy-and-pay";
import { slotsForRequest, slotsForTopUp } from "@/server/modules/engagements/purchase";
import { bookAgainList, packagesForStudent, sessionBoardForStudent, sessionBoardForTutor } from "@/server/modules/engagements/reads";
import { engagementsDueForTermEndRefund, endPackage, runTermEndRefunds } from "@/server/modules/engagements/termEnd";
import { cleanup, delivered, operator, person, rows, run, world, type World } from "@/server/modules/billing/test-world";
import { requestsForStudent, requestTutors, standingFor } from "@/server/modules/matching/requests";
import { runNotifications } from "@/server/modules/notifications/dispatch";
import { cardRatings } from "@/server/modules/ratings/reads";
import { earningsForTutor, feeToDateForTutor } from "@/server/modules/tutoring/earnings";

import { resetTestUsers } from "./ops";
import { personaUserId, type PersonaCampus } from "./people";
import { resetPersonas } from "./reset";
import { STUDENT_PERSONAS } from "./students";
import { FINALS_COURSE, TERM_OVER_COURSE } from "./term";
import { TUTOR_PERSONAS } from "./tutors";
import { wipePersonas } from "./wipe";

let w: World;
let campus: PersonaCampus;
let bystander: { engagementId: string };

after(async () => {
  await wipePersonas(w.institutionId);
  await cleanup();
});

before(async () => {
  w = await world();
  campus = { institutionId: w.institutionId, testRun: run };
  await db.insert(term).values({ institutionId: w.institutionId, name: "Before", startsOn: "2020-01-06", endsOn: "2020-05-01" });
  const courses = [...TUTOR_PERSONAS.map((persona) => persona.course), ...STUDENT_PERSONAS.flatMap((persona) => persona.pair?.course ?? []), FINALS_COURSE, TERM_OVER_COURSE];
  for (const code of new Set(courses)) {
    const [row] = await db.insert(course).values({ institutionId: w.institutionId, title: code, department: "TEST" }).returning({ id: course.id });
    await db.insert(courseCodeAlias).values({ institutionId: w.institutionId, courseId: row.id, code });
    await db.insert(courseOffering).values({ institutionId: w.institutionId, courseId: row.id, termId: w.termId, section: "001" });
  }
  bystander = await delivered(w);
});

const tutor = (key: string) => tutorActorFor(personaUserId(campus, key));
const student = (key: string) => actorFor(personaUserId(campus, key));

async function fees(key: string): Promise<number[]> {
  const { tutorProfileId } = await tutor(key);
  const found = await db
    .select({ amountMinor: ledgerEntry.amountMinor })
    .from(ledgerEntry)
    .innerJoin(engagement, eq(engagement.id, ledgerEntry.engagementId))
    .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
    .where(and(eq(tutorCourse.tutorProfileId, tutorProfileId), eq(ledgerEntry.type, "platform_fee")))
    .orderBy(asc(ledgerEntry.occurredAt), asc(ledgerEntry.id));
  return found.map((row) => row.amountMinor);
}

async function visibleState() {
  const found = await db.execute(sql`
    select tutor.user_id as tutor, student.user_id as student, e.kind, e.status, e.price_paid_minor,
      (select string_agg(s.status || '/' || coalesce(s.resolution::text, '-'), ' ' order by s.scheduled_at)
         from session_booking s where s.engagement_id = e.id) as sessions,
      (select string_agg(l.type || ':' || l.amount_minor || ':' || coalesce(left(l.stripe_reference, 11), '-'), ' ' order by l.occurred_at, l.type)
         from ledger_entry l where l.engagement_id = e.id) as ledger,
      (select string_agg(r.stars || ':' || (r.released_at is not null), ' ' order by r.stars)
         from session_rating r join session_booking s on s.id = r.session_id where s.engagement_id = e.id) as ratings,
      tc.session_rate_minor, tc.score_sample_count, tc.renewal_trial_count, tutor.kyc_status
    from engagement e
    join student_profile student on student.id = e.student_profile_id
    join tutor_course tc on tc.id = e.tutor_course_id
    join tutor_profile tutor on tutor.id = tc.tutor_profile_id
    where e.institution_id = ${w.institutionId}
    order by tutor.user_id, student.user_id, e.created_at
  `);
  return [...found];
}

test("tutor personas earn what the real pricing code says, and the money check passes", async () => {
  const built = await resetPersonas(campus);
  assert.deepEqual(
    built.map((persona) => persona.key),
    [
      ...TUTOR_PERSONAS.map((persona) => persona.key),
      "student-new",
      "student-accepted",
      "student-accepted-tutor",
      "student-mid",
      "student-mid-tutor",
      "student-confirm",
      "student-confirm-tutor",
      "student-done",
      "student-done-tutor",
      "student-refund",
      "student-refund-tutor",
      "student-strikes",
      "student-strikes-tutor",
      "tutor-finals",
      "student-finals",
      "student-term-over",
      "student-term-over-tutor",
    ],
  );

  assert.deepEqual(await earningsForTutor(await tutor("tutor-1")), {
    earnedMinor: 4_500,
    owedMinor: 4_500,
    transferredMinor: 0,
    currency: "usd",
    sessionsDelivered: 1,
  });
  assert.deepEqual(await earningsForTutor(await tutor("tutor-10")), {
    earnedMinor: 90_000,
    owedMinor: 90_000,
    transferredMinor: 0,
    currency: "usd",
    sessionsDelivered: 10,
  });
  assert.deepEqual(await earningsForTutor(await tutor("tutor-32")), {
    earnedMinor: 101_400,
    owedMinor: 38_400,
    transferredMinor: 63_000,
    currency: "usd",
    sessionsDelivered: 32,
  });
  assert.deepEqual(await fees("tutor-32"), [...Array(28).fill(350), 275, 175, 175, 175]);

  assert.deepEqual(await fees("tutor-past-100"), [...Array(20).fill(500), ...Array(12).fill(250)]);
  assert.equal(await feeToDateForTutor(await tutor("tutor-past-100")), 13_000);
  assert.deepEqual(await earningsForTutor(await tutor("tutor-past-100")), {
    earnedMinor: 147_000,
    owedMinor: 19_000,
    transferredMinor: 128_000,
    currency: "usd",
    sessionsDelivered: 32,
  });

  const ten = await tutor("tutor-10");
  const nine = await tutor("tutor-9");
  assert.equal(await feeToDateForTutor(ten), 10_000);
  assert.equal(await feeToDateForTutor(nine), 9_000);
  const claims = await db
    .select({ id: tutorCourse.id, tutorProfileId: tutorCourse.tutorProfileId })
    .from(tutorCourse)
    .where(eq(tutorCourse.institutionId, w.institutionId));
  const claimOf = (tutorProfileId: string) => claims.find((row) => row.tutorProfileId === tutorProfileId)!.id;
  const ratings = await cardRatings(w.institutionId, [claimOf(ten.tutorProfileId), claimOf(nine.tutorProfileId)]);
  assert.deepEqual(ratings.get(claimOf(ten.tutorProfileId))?.courseRating, { average: "4.8", count: 5 });
  assert.equal(ratings.get(claimOf(nine.tutorProfileId))?.courseRating, null);

  await assertMoneyInvariants(w.institutionId);
});

test("a $25 through-final package pays 2_250 a session, and 11 sessions stay at 10% below $100", async () => {
  assert.deepEqual(await fees("tutor-held"), Array(11).fill(225));
  assert.deepEqual(await earningsForTutor(await tutor("tutor-held")), {
    earnedMinor: 22_275,
    owedMinor: 22_275,
    transferredMinor: 0,
    currency: "usd",
    sessionsDelivered: 11,
  });
});

test("each student persona sees its package, what it paid and whether it can end", async () => {
  const packages = async (key: string) =>
    (await packagesForStudent(await student(key))).map((pkg) => ({
      kind: pkg.kind,
      courseCode: pkg.courseCode,
      tutorName: pkg.tutorName,
      sessionsDelivered: pkg.sessionsDelivered,
      sessionsRemaining: pkg.sessionsRemaining,
      pricePaidMinor: pkg.pricePaidMinor,
      refundMinor: pkg.ending.refundMinor,
      blocked: pkg.ending.blocked?.reason ?? null,
    }));
  const accepted = async (key: string) =>
    (await requestsForStudent(await student(key))).map((request) => ({
      status: request.status,
      courseCode: request.courseCode,
      requestedKind: request.requestedKind,
      rateMinor: request.rateMinor,
      engagementId: request.engagementId,
    }));

  assert.deepEqual(await accepted("student-new"), []);
  assert.deepEqual(await packages("student-new"), []);

  assert.deepEqual(await accepted("student-accepted"), [
    { status: "accepted", courseCode: "MATH 125", requestedKind: "exam_anchored", rateMinor: 4_000, engagementId: null },
  ]);
  assert.deepEqual(await accepted("student-refund"), [
    { status: "accepted", courseCode: "EC 110", requestedKind: "through_final", rateMinor: 2_500, engagementId: null },
  ]);

  assert.deepEqual(await packages("student-mid"), [
    {
      kind: "exam_anchored",
      courseCode: "CH 101",
      tutorName: "Grace Kim",
      sessionsDelivered: 2,
      sessionsRemaining: 1,
      pricePaidMinor: 12_000,
      refundMinor: 6_000,
      blocked: null,
    },
  ]);
  assert.equal((await sessionBoardForStudent(await student("student-mid"))).upcoming.length, 1);

  assert.deepEqual(await packages("student-confirm"), [
    {
      kind: "exam_anchored",
      courseCode: "BSC 114",
      tutorName: "Ben Carter",
      sessionsDelivered: 1,
      sessionsRemaining: 2,
      pricePaidMinor: 18_000,
      refundMinor: 13_500,
      blocked: "awaiting_answer",
    },
  ]);
  const toConfirm = (await sessionBoardForStudent(await student("student-confirm"))).awaitingAnswer;
  assert.deepEqual(
    toConfirm.map((item) => ({ otherPartyName: item.otherPartyName, yourAnswer: item.yourAnswer, action: item.action })),
    [{ otherPartyName: "Ben Carter", yourAnswer: null, action: "confirm_or_deny" }],
  );

  assert.deepEqual(await packages("student-done"), []);
  assert.deepEqual(
    (await bookAgainList(await student("student-done"))).map((pair) => ({
      courseCode: pair.courseCode,
      tutorName: pair.tutorName,
      sessionRateMinor: pair.sessionRateMinor,
      liveRequest: pair.liveRequest,
    })),
    [{ courseCode: "MATH 126", tutorName: "Zoe Hart", sessionRateMinor: 3_500, liveRequest: null }],
  );

  assert.deepEqual(await packages("student-strikes"), [
    {
      kind: "exam_anchored",
      courseCode: "ST 260",
      tutorName: "Sam Novak",
      sessionsDelivered: 1,
      sessionsRemaining: 1,
      pricePaidMinor: 20_000,
      refundMinor: 7_500,
      blocked: null,
    },
  ]);
  assert.deepEqual(await standingFor(await student("student-strikes")), {
    parallelAskLimit: 1,
    depositRequired: true,
    cleanSessionsToRecover: 3,
  });
  assert.equal((await standingFor(await student("student-mid"))).parallelAskLimit, 3);
});

test("running the reset again rebuilds the same personas and leaves everyone else alone", async () => {
  const bystanderLedger = await rows(bystander.engagementId, "tutor_accrued");
  const first = await visibleState();
  assert.equal(first.length, 43);

  await resetPersonas(campus);

  assert.deepEqual(await visibleState(), first);
  assert.deepEqual(await rows(bystander.engagementId, "tutor_accrued"), bystanderLedger);
  await assertMoneyInvariants(w.institutionId);
});

test("finals week: three students sit the final in four days, each with a session a day until then", async () => {
  const [{ finalOn }] = await db.execute<{ finalOn: string }>(sql`select (current_date + 4)::text as "finalOn"`);
  const finals = await student("student-finals");
  assert.deepEqual(
    (await packagesForStudent(finals)).map((pkg) => ({
      courseCode: pkg.courseCode,
      section: pkg.section,
      sessionsDelivered: pkg.sessionsDelivered,
      sessionsRemaining: pkg.sessionsRemaining,
      pricePaidMinor: pkg.pricePaidMinor,
      anchorExamName: pkg.anchorExamName,
      anchorExamOccursOn: pkg.anchorExamOccursOn,
    })),
    [
      {
        courseCode: "MATH 125",
        section: "persona",
        sessionsDelivered: 1,
        sessionsRemaining: 0,
        pricePaidMinor: 18_000,
        anchorExamName: "Final Exam",
        anchorExamOccursOn: finalOn,
      },
    ],
  );
  const [{ timezone }] = await db.select({ timezone: institution.timezone }).from(institution).where(eq(institution.id, w.institutionId));
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
  const days = (await sessionBoardForStudent(finals)).upcoming.map((item) => day.format(item.scheduledAt)).sort();
  const dayAfter = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.deepEqual(days, [days[0], dayAfter(days[0], 1), dayAfter(days[0], 2)]);
  assert.ok(days[2] < finalOn, `${days[2]} is before the final on ${finalOn}`);
  assert.deepEqual(
    (await bookAgainList(finals)).map((pair) => pair.tutorName),
    ["Iris Vance"],
  );
  const [math] = await db.select({ courseId: courseCodeAlias.courseId }).from(courseCodeAlias).where(and(eq(courseCodeAlias.institutionId, w.institutionId), eq(courseCodeAlias.code, "MATH 125")));
  assert.deepEqual(
    (await offeringsForCourse({ courseId: math.courseId, institutionId: w.institutionId })).map((offering) => offering.section),
    ["001"],
  );

  const tutorFinals = await tutor("tutor-finals");
  const upcoming = (await sessionBoardForTutor(tutorFinals)).upcoming.map((item) => item.scheduledAt.getTime()).sort((a, b) => a - b);
  assert.equal(upcoming.length, 9);
  assert.ok(upcoming.at(-1)! - upcoming[0] < 3 * 24 * 60 * 60 * 1000);
  assert.deepEqual(await earningsForTutor(tutorFinals), {
    earnedMinor: 12_150,
    owedMinor: 12_150,
    transferredMinor: 0,
    currency: "usd",
    sessionsDelivered: 3,
  });
});

test("term over: the real term-end sweep refunds the two unused sessions", async () => {
  const termOver = await student("student-term-over");
  const [pkg] = await packagesForStudent(termOver);
  assert.deepEqual(await engagementsDueForTermEndRefund(w.institutionId), [
    {
      engagementId: pkg.engagementId,
      studentProfileId: termOver.studentProfileId,
      sessionsPurchased: 4,
      sessionsDelivered: 2,
      refundMinor: 8_000,
      currency: "usd",
    },
  ]);
  const { refunds, held, failed } = await runTermEndRefunds(w.institutionId);

  assert.deepEqual(
    { refunded: refunds.map((refund) => [refund.engagementId, refund.refundMinor]), held, failed },
    { refunded: [[pkg.engagementId, 8_000]], held: 0, failed: 0 },
  );
  assert.deepEqual(await packagesForStudent(termOver), []);
  assert.deepEqual(await engagementsDueForTermEndRefund(w.institutionId), []);
  assert.deepEqual(
    (await rows(pkg.engagementId, "refund")).map((row) => [row.amountMinor, row.stripeReference]),
    [[8_000, null]],
  );
  await assertMoneyInvariants(w.institutionId);
});

test("a tester can buy and end student-refund's package and top up student-done", async () => {
  const refunder = await student("student-refund");
  const [request] = await requestsForStudent(refunder);
  const slots = await slotsForRequest({ actor: refunder, requestId: request.id });
  const { engagementId } = await buyPackage({ actor: refunder, requestId: request.id, anchorExamId: null, slotStartsAt: slots.at(-1)! });
  assert.deepEqual(await endPackage({ actor: refunder, engagementId }), {
    engagementId,
    studentProfileId: refunder.studentProfileId,
    sessionsPurchased: 8,
    sessionsDelivered: 0,
    refundMinor: 18_000,
    currency: "usd",
  });

  const done = await student("student-done");
  const [pair] = await bookAgainList(done);
  const [slot] = await slotsForTopUp({ actor: done, tutorCourseId: pair.tutorCourseId });
  await buyTopUp({ actor: done, tutorCourseId: pair.tutorCourseId, slotStartsAt: slot });
  assert.deepEqual(
    (await packagesForStudent(done)).map((pkg) => ({ kind: pkg.kind, sessionsRemaining: pkg.sessionsRemaining, pricePaidMinor: pkg.pricePaidMinor })),
    [{ kind: "top_up", sessionsRemaining: 0, pricePaidMinor: 3_500 }],
  );

  await assertMoneyInvariants(w.institutionId);
});

test("the reset refuses to delete a request a real student sent a persona tutor", async () => {
  const { tutorProfileId } = await tutor("tutor-new");
  const [claim] = await db
    .select({ id: tutorCourse.id, offeringId: courseOffering.id })
    .from(tutorCourse)
    .innerJoin(courseOffering, eq(courseOffering.courseId, tutorCourse.courseId))
    .where(eq(tutorCourse.tutorProfileId, tutorProfileId));
  const student = await person(w.institutionId);
  await requestTutors({ actor: student, courseOfferingId: claim.offeringId, tutorCourseIds: [claim.id], kind: "exam_anchored" });
  const before = await visibleState();

  await assert.rejects(resetPersonas(campus), /A real account shares these rows with a test user/);
  process.env.TEST_PERSONAS = "on";
  const refused = await resetTestUsers(await operator(w.institutionId));
  assert.equal(refused.status, "refused");
  assert.match(refused.status === "refused" ? refused.message : "", /^Nothing was reset\. A real account shares these rows with a test user\./);
  assert.deepEqual(await visibleState(), before);
  assert.equal(
    (await db.select({ id: matchRequest.id }).from(matchRequest).where(eq(matchRequest.studentProfileId, student.studentProfileId))).length,
    1,
  );

  await db.delete(messageThread).where(eq(messageThread.studentProfileId, student.studentProfileId));
  await db.delete(matchRequest).where(eq(matchRequest.studentProfileId, student.studentProfileId));
});

test("while a reset runs, the email sweep sends nothing and a second reset is refused", async () => {
  process.env.TEST_PERSONAS = "on";
  let finished = false;
  const resetting = resetPersonas(campus).finally(() => (finished = true));
  const midway = async () =>
    (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from engagement e
      join pg_locks l on l.locktype = 'advisory' and l.mode = 'ExclusiveLock' and l.objid = hashtext(${w.institutionId})::oid
      where e.institution_id = ${w.institutionId} and e.id <> ${bystander.engagementId}
    `))[0].n;
  while (!finished && (await midway()) === 0) await sleep(5);
  assert.equal(finished, false);

  const sentMidway = await runNotifications(w.institutionId);
  const second = await resetPersonas(campus).then(
    () => "built",
    (error: Error) => error.message,
  );
  await resetting;

  assert.equal(sentMidway, 0);
  assert.match(second, /already being reset/);
  assert.equal(await runNotifications(w.institutionId), 2);
});
