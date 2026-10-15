import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "../index";
import { course, courseCodeAlias, courseOffering, engagement, ledgerEntry, matchRequest, messageThread, term, tutorCourse } from "../schema";
import { tutorActorFor } from "../scenarios/people";

import { assertMoneyInvariants } from "@/server/modules/billing/invariants";
import { cleanup, delivered, person, rows, run, world, type World } from "@/server/modules/billing/test-world";
import { requestTutors } from "@/server/modules/matching/requests";
import { cardRatings } from "@/server/modules/ratings/reads";
import { earningsForTutor, feeCapProgressForTutor } from "@/server/modules/tutoring/earnings";

import { personaUserId, type PersonaCampus } from "./people";
import { resetPersonas } from "./reset";
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
  for (const code of new Set(TUTOR_PERSONAS.map((persona) => persona.course))) {
    const [row] = await db.insert(course).values({ institutionId: w.institutionId, title: code, department: "TEST" }).returning({ id: course.id });
    await db.insert(courseCodeAlias).values({ institutionId: w.institutionId, courseId: row.id, code });
    await db.insert(courseOffering).values({ institutionId: w.institutionId, courseId: row.id, termId: w.termId, section: "001" });
  }
  bystander = await delivered(w);
});

const tutor = (key: string) => tutorActorFor(personaUserId(campus, key));

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
    TUTOR_PERSONAS.map((persona) => persona.key),
  );

  assert.deepEqual(await earningsForTutor(await tutor("tutor-1")), {
    earnedMinor: 4_500,
    owedMinor: 4_500,
    transferredMinor: 0,
    currency: "usd",
    sessionsDelivered: 1,
  });
  assert.deepEqual(await earningsForTutor(await tutor("tutor-10")), {
    earnedMinor: 31_500,
    owedMinor: 31_500,
    transferredMinor: 0,
    currency: "usd",
    sessionsDelivered: 10,
  });
  assert.deepEqual(await earningsForTutor(await tutor("tutor-32")), {
    earnedMinor: 104_650,
    owedMinor: 39_900,
    transferredMinor: 64_750,
    currency: "usd",
    sessionsDelivered: 32,
  });
  assert.deepEqual(await fees("tutor-32"), [...Array(10).fill(350), ...Array(22).fill(175)]);

  assert.deepEqual(await fees("tutor-capped"), [...Array(10).fill(500), ...Array(20).fill(250), 0, 0]);
  assert.equal((await feeCapProgressForTutor(await tutor("tutor-capped")))?.chargedMinor, 10_000);

  const ten = await tutor("tutor-10");
  const nine = await tutor("tutor-9");
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

test("a $25 through-final package pays 2_250 a session, and the 11th session takes the lower fee", async () => {
  assert.deepEqual(await fees("tutor-held"), [...Array(10).fill(225), 112]);
  assert.deepEqual(await earningsForTutor(await tutor("tutor-held")), {
    earnedMinor: 22_388,
    owedMinor: 22_388,
    transferredMinor: 0,
    currency: "usd",
    sessionsDelivered: 11,
  });
});

test("running the reset again rebuilds the same personas and leaves everyone else alone", async () => {
  const bystanderLedger = await rows(bystander.engagementId, "tutor_accrued");
  const first = await visibleState();
  assert.equal(first.length, 35);

  await resetPersonas(campus);

  assert.deepEqual(await visibleState(), first);
  assert.deepEqual(await rows(bystander.engagementId, "tutor_accrued"), bystanderLedger);
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

  await assert.rejects(resetPersonas(campus), /pair a persona with a real account/);
  assert.deepEqual(await visibleState(), before);
  assert.equal(
    (await db.select({ id: matchRequest.id }).from(matchRequest).where(eq(matchRequest.studentProfileId, student.studentProfileId))).length,
    1,
  );

  await db.delete(messageThread).where(eq(messageThread.studentProfileId, student.studentProfileId));
  await db.delete(matchRequest).where(eq(matchRequest.studentProfileId, student.studentProfileId));
});
