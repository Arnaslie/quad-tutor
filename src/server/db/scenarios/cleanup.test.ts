import assert from "node:assert/strict";
import { after, test } from "node:test";

import { eq, inArray } from "drizzle-orm";

import { accepted, cleanup, world, type World } from "@/server/modules/billing/test-world";

import { db } from "../index";
import { engagement, sessionBooking } from "../schema";

import { cleanupByMarker } from "./cleanup";

after(cleanup);

async function held(w: World, note: string) {
  const { actor, buy } = await accepted(w);
  const { engagementId } = await buy();
  await db.update(sessionBooking).set({ studentNote: note }).where(eq(sessionBooking.engagementId, engagementId));
  return { actor, engagementId };
}

test("the marker matches literally and only on the student's own campus", async () => {
  const here = await world();
  const elsewhere = await world();
  const mine = await held(here, "db_demo");
  const lookalike = await held(here, "dbXdemo");
  const otherCampus = await held(elsewhere, "db_demo");

  const removed = await cleanupByMarker({
    student: mine.actor,
    targets: [{ courseOfferingId: here.offeringId, tutorCourseIds: [here.tutorCourseId], accepterTutorCourseId: here.tutorCourseId }],
    marker: "db_demo",
  });

  assert.deepEqual(removed, { engagements: 1, requests: 0 });
  const left = await db
    .select({ id: engagement.id })
    .from(engagement)
    .where(inArray(engagement.id, [mine.engagementId, lookalike.engagementId, otherCampus.engagementId]));
  assert.deepEqual(left.map((row) => row.id).sort(), [lookalike.engagementId, otherCampus.engagementId].sort());
});
