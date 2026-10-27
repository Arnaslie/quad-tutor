import assert from "node:assert/strict";
import { after, test } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { courseOffering, engagement, exam } from "@/server/db/schema";
import { accepted, cleanup, world } from "@/server/modules/billing/test-world";

after(cleanup);

test("ten students buying the same tutor's first open time at once get it once between them", async () => {
  const w = await world();
  const students = [];
  for (let i = 0; i < 10; i += 1) students.push(await accepted(w));

  const results = await Promise.allSettled(students.map((student) => student.buy()));

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.deepEqual(
    [...new Set(results.flatMap((result) => (result.status === "rejected" ? [(result.reason as Error).message] : [])))],
    ["That time is no longer available."],
  );
});

test("a package anchors only to an exam of the offering the student asked about", async () => {
  const w = await world();
  const elsewhere = await world();
  const [offering] = await db.select({ courseId: courseOffering.courseId }).from(courseOffering).where(eq(courseOffering.id, w.offeringId));
  const [otherSection] = await db
    .insert(courseOffering)
    .values({ institutionId: w.institutionId, courseId: offering.courseId, termId: w.termId, section: "002" })
    .returning({ id: courseOffering.id });
  const occursOn = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const [ours, otherSectionExam, otherCampusExam] = await db
    .insert(exam)
    .values([
      { institutionId: w.institutionId, courseOfferingId: w.offeringId, name: "Midterm", occursOn },
      { institutionId: w.institutionId, courseOfferingId: otherSection.id, name: "Midterm", occursOn },
      { institutionId: elsewhere.institutionId, courseOfferingId: elsewhere.offeringId, name: "Midterm", occursOn },
    ])
    .returning({ id: exam.id });

  const student = await accepted(w);
  const refusals = await Promise.allSettled([otherSectionExam.id, otherCampusExam.id].map((id) => student.buy(id)));
  assert.deepEqual(
    refusals.map((result) => (result.status === "rejected" ? (result.reason as Error).message : "bought")),
    ["That exam is not part of this course.", "That exam is not part of this course."],
  );

  const { engagementId } = await student.buy(ours.id);
  const [row] = await db.select({ anchorExamId: engagement.anchorExamId }).from(engagement).where(eq(engagement.id, engagementId));
  assert.equal(row.anchorExamId, ours.id);
});
