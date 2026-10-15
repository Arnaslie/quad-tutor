import assert from "node:assert/strict";
import { after, test } from "node:test";

import { and, asc, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { engagement, ledgerEntry, tutorCourse } from "@/server/db/schema";
import { feeCapProgressForTutor } from "@/server/modules/tutoring/earnings";

import { assertMoneyInvariants } from "./invariants";
import { anotherSessionDelivered, cleanup, delivered, world } from "./test-world";

after(cleanup);

test("the 10th session at $35 takes $3.50, the 11th $1.75, and earlier fees stay as written", async () => {
  const w = await world();

  for (let pack = 0; pack < 3; pack += 1) {
    const { actor, engagementId } = await delivered(w);
    const more = pack < 2 ? 3 : 2;
    for (let i = 0; i < more; i += 1) await anotherSessionDelivered(w, actor, engagementId);
    if (pack === 0) {
      assert.deepEqual(await feeCapProgressForTutor(w.tutor), {
        chargedMinor: 1_400,
        capMinor: 10_000,
        termName: "Now",
        sessionsEarned: 4,
        rateBp: 1_000,
      });
    }
  }

  const fees = await db
    .select({ amountMinor: ledgerEntry.amountMinor })
    .from(ledgerEntry)
    .innerJoin(engagement, eq(engagement.id, ledgerEntry.engagementId))
    .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
    .where(and(eq(tutorCourse.tutorProfileId, w.tutor.tutorProfileId), eq(ledgerEntry.type, "platform_fee")))
    .orderBy(asc(ledgerEntry.occurredAt), asc(ledgerEntry.id));

  assert.deepEqual(
    fees.map((fee) => fee.amountMinor),
    [350, 350, 350, 350, 350, 350, 350, 350, 350, 350, 175],
  );
  assert.deepEqual(await feeCapProgressForTutor(w.tutor), {
    chargedMinor: 3_675,
    capMinor: 10_000,
    termName: "Now",
    sessionsEarned: 11,
    rateBp: 500,
  });
  await assertMoneyInvariants(w.institutionId);
});
