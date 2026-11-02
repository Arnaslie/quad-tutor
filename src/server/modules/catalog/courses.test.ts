import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { inArray } from "drizzle-orm";

import { db } from "@/server/db";
import { isLocalHost } from "@/server/db/local-host.mjs";
import {
  course,
  courseCodeAlias,
  courseOffering,
  exam,
  institution,
  term,
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";
import { PERSONA_SECTION } from "@/server/modules/billing/fixtures";

import { courseTicker } from "./courses";

const databaseHost = new URL(process.env.DATABASE_URL ?? "postgres://unset").hostname;
if (!isLocalHost(databaseHost)) {
  throw new Error(`Refusing to run tests against ${databaseHost}: point DATABASE_URL at a local database.`);
}

const run = randomUUID().slice(0, 8);
const made = { institutions: [] as string[], users: [] as string[] };

async function campus(slug: string) {
  const [inst] = await db
    .insert(institution)
    .values({
      name: `Test ${slug}`,
      slug: `test-${slug}-${run}`,
      emailDomain: `${slug}-${run}.test`,
      timezone: "America/Chicago",
    })
    .returning({ id: institution.id });
  made.institutions.push(inst.id);

  const [now] = await db
    .insert(term)
    .values({ institutionId: inst.id, name: "Now", startsOn: "2020-01-01", endsOn: "2099-12-31" })
    .returning({ id: term.id });

  async function seededCourse(code: string, isSeeded = true) {
    const [row] = await db
      .insert(course)
      .values({ institutionId: inst.id, title: `${code} title`, department: "TEST", isSeeded })
      .returning({ id: course.id });
    await db.insert(courseCodeAlias).values({ institutionId: inst.id, courseId: row.id, code });
    return row.id;
  }

  async function offering(courseId: string, section: string, examsOn: string[]) {
    const [row] = await db
      .insert(courseOffering)
      .values({ institutionId: inst.id, courseId, termId: now.id, section })
      .returning({ id: courseOffering.id });
    for (const occursOn of examsOn) {
      await db
        .insert(exam)
        .values({ institutionId: inst.id, courseOfferingId: row.id, name: "Exam", occursOn });
    }
  }

  async function tutor(key: string, claims: { courseId: string; status: "active" | "pending_verification" }[]) {
    const id = `test_ticker_${key}_${run}`;
    await db.insert(user).values({ id, name: key, email: `${id}@example.test`, emailVerified: true });
    made.users.push(id);
    const [profile] = await db
      .insert(tutorProfile)
      .values({ userId: id, institutionId: inst.id })
      .returning({ id: tutorProfile.id });
    for (const claim of claims) {
      await db.insert(tutorCourse).values({
        institutionId: inst.id,
        tutorProfileId: profile.id,
        courseId: claim.courseId,
        takenTermId: now.id,
        gradeEarned: "A",
        status: claim.status,
      });
    }
  }

  return { institutionId: inst.id, seededCourse, offering, tutor };
}

after(async () => {
  const institutions = made.institutions;
  await db.delete(exam).where(inArray(exam.institutionId, institutions));
  await db.delete(tutorCourse).where(inArray(tutorCourse.institutionId, institutions));
  await db.delete(tutorProfile).where(inArray(tutorProfile.userId, made.users));
  await db.delete(user).where(inArray(user.id, made.users));
  await db.delete(courseOffering).where(inArray(courseOffering.institutionId, institutions));
  await db.delete(courseCodeAlias).where(inArray(courseCodeAlias.institutionId, institutions));
  await db.delete(course).where(inArray(course.institutionId, institutions));
  await db.delete(term).where(inArray(term.institutionId, institutions));
  await db.delete(institution).where(inArray(institution.id, institutions));
  await db.$client.end();
});

test("the ticker lists this campus's seeded courses with active tutors, counting each tutor once, with the next real exam", async () => {
  const home = await campus("ticker-home");
  const elsewhere = await campus("ticker-away");

  const calculus = await home.seededCourse("TKR 200");
  const biology = await home.seededCourse("TKR 100");
  const pendingOnly = await home.seededCourse("TKR 300");
  const unseeded = await home.seededCourse("TKR 400", false);
  const away = await elsewhere.seededCourse("TKR 150");

  await home.offering(calculus, "001", ["2020-02-01", "2099-03-01", "2099-04-01"]);
  await home.offering(calculus, "002", ["2099-05-01"]);
  await home.offering(calculus, PERSONA_SECTION, ["2099-01-01"]);
  await home.offering(biology, "001", []);

  await home.tutor("ana", [
    { courseId: calculus, status: "active" },
    { courseId: biology, status: "active" },
  ]);
  await home.tutor("ben", [{ courseId: calculus, status: "active" }]);
  await home.tutor("cy", [
    { courseId: calculus, status: "pending_verification" },
    { courseId: pendingOnly, status: "pending_verification" },
    { courseId: unseeded, status: "active" },
  ]);
  await elsewhere.tutor("dee", [{ courseId: away, status: "active" }]);

  assert.deepEqual(await courseTicker(home.institutionId), [
    { courseId: biology, code: "TKR 100", title: "TKR 100 title", tutorCount: 1, nextExamOn: null },
    { courseId: calculus, code: "TKR 200", title: "TKR 200 title", tutorCount: 2, nextExamOn: "2099-03-01" },
  ]);
});
