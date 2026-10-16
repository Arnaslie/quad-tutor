import assert from "node:assert/strict";
import { after, test } from "node:test";

import { and, asc, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { engagement, ledgerEntry, tutorCourse } from "@/server/db/schema";
import { setCourseRate } from "@/server/modules/tutoring/courses";
import { feeToDateForTutor } from "@/server/modules/tutoring/earnings";

import { assertMoneyInvariants } from "./invariants";
import { feesToDate } from "./ledger";
import { anotherSessionDelivered, cleanup, delivered, world } from "./test-world";

after(cleanup);

test("at $95 the 11th session splits at the $100 line, the 12th takes 5%, and earlier fees stay as written", async () => {
  const w = await world();
  await setCourseRate({ tutor: w.tutor, tutorCourseId: w.tutorCourseId, rateMinor: 9_500 });

  for (let pack = 0; pack < 3; pack += 1) {
    const { actor, engagementId } = await delivered(w);
    for (let i = 0; i < 3; i += 1) await anotherSessionDelivered(w, actor, engagementId);
    if (pack === 0) assert.equal(await feeToDateForTutor(w.tutor), 3_800);
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
    [950, 950, 950, 950, 950, 950, 950, 950, 950, 950, 725, 475],
  );
  assert.equal(await feeToDateForTutor(w.tutor), 10_700);
  await assertMoneyInvariants(w.institutionId);
});

test("the fee meter counts one campus only", async () => {
  const w = await world();
  const elsewhere = await world();
  await delivered(w);

  assert.deepEqual(await feesToDate(db, w.institutionId, [w.tutor.tutorProfileId]), new Map([[w.tutor.tutorProfileId, 350]]));
  assert.deepEqual(await feesToDate(db, elsewhere.institutionId, [w.tutor.tutorProfileId]), new Map());
});
