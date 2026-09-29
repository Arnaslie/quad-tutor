import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { engagement, sessionBooking, tutorCourse, tutorProfile } from "@/server/db/schema";
import type { TutorActor } from "@/server/modules/identity/actor";

export async function defaultLocationFor(tutor: TutorActor): Promise<string | null> {
  const [row] = await db
    .select({ location: tutorProfile.defaultLocation })
    .from(tutorProfile)
    .where(eq(tutorProfile.id, tutor.tutorProfileId));

  return row?.location ?? null;
}

export async function setDefaultLocation(params: {
  tutor: TutorActor;
  location: string;
}): Promise<{ filled: number }> {
  const now = new Date();

  return db.transaction(async (tx) => {
    await tx
      .update(tutorProfile)
      .set({ defaultLocation: params.location })
      .where(eq(tutorProfile.id, params.tutor.tutorProfileId));

    const theirs = tx
      .select({ id: engagement.id })
      .from(engagement)
      .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
      .where(eq(tutorCourse.tutorProfileId, params.tutor.tutorProfileId));

    const filled = await tx
      .update(sessionBooking)
      .set({
        location: params.location,
        locationChangedAt: sql`case when ${sessionBooking.bookedNotifiedAt} is not null then ${now.toISOString()}::timestamptz end`,
      })
      .where(
        and(
          inArray(sessionBooking.engagementId, theirs),
          eq(sessionBooking.status, "scheduled"),
          isNull(sessionBooking.location),
          gt(sessionBooking.scheduledAt, now),
        ),
      )
      .returning({ id: sessionBooking.id });

    return { filled: filled.length };
  });
}
