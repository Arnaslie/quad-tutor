import { and, eq, inArray, isNotNull, like, notInArray } from "drizzle-orm";

import { db } from "../index";
import { escapeLike } from "../like";
import {
  engagement,
  ledgerEntry,
  matchRequest,
  reliabilityEvent,
  sessionBooking,
} from "../schema";

import type { Actor } from "@/server/modules/identity/actor";

import type { Target } from "./packages";

export async function cleanupByMarker(params: {
  student: Actor;
  targets: Target[];
  marker: string;
}): Promise<{ engagements: number; requests: number }> {
  const offeringIds = params.targets.map((target) => target.courseOfferingId);
  const tutorCourseIds = params.targets.flatMap((target) => target.tutorCourseIds);

  const { institutionId } = params.student;

  const ours = and(
    eq(matchRequest.institutionId, institutionId),
    eq(matchRequest.studentProfileId, params.student.studentProfileId),
    inArray(matchRequest.courseOfferingId, offeringIds),
    inArray(matchRequest.tutorCourseId, tutorCourseIds),
  );

  return db.transaction(async (tx) => {
    const marked = await tx
      .selectDistinct({ id: sessionBooking.engagementId })
      .from(sessionBooking)
      .where(
        and(
          eq(sessionBooking.institutionId, institutionId),
          like(sessionBooking.studentNote, `%${escapeLike(params.marker)}%`),
        ),
      );

    const fromRequests = await tx
      .select({ id: engagement.id })
      .from(engagement)
      .innerJoin(matchRequest, eq(matchRequest.id, engagement.matchRequestId))
      .where(and(eq(engagement.institutionId, institutionId), ours));

    const engagementIds = [
      ...new Set([...marked, ...fromRequests].map((row) => row.id)),
    ];

    if (engagementIds.length > 0) {
      const sessions = await tx
        .select({ id: sessionBooking.id })
        .from(sessionBooking)
        .where(inArray(sessionBooking.engagementId, engagementIds));
      const sessionIds = sessions.map((row) => row.id);

      const requests = await tx
        .select({ id: engagement.matchRequestId })
        .from(engagement)
        .where(
          and(inArray(engagement.id, engagementIds), isNotNull(engagement.matchRequestId)),
        );

      if (sessionIds.length > 0) {
        await tx
          .delete(reliabilityEvent)
          .where(inArray(reliabilityEvent.sessionId, sessionIds));
      }
      await tx.delete(ledgerEntry).where(inArray(ledgerEntry.engagementId, engagementIds));
      await tx
        .delete(sessionBooking)
        .where(inArray(sessionBooking.engagementId, engagementIds));
      await tx.delete(engagement).where(inArray(engagement.id, engagementIds));

      const requestIds = requests
        .map((row) => row.id)
        .filter((id): id is string => id !== null);
      if (requestIds.length > 0) {
        await tx.delete(matchRequest).where(inArray(matchRequest.id, requestIds));
      }
    }

    const attached = await tx
      .select({ id: engagement.matchRequestId })
      .from(engagement)
      .where(and(eq(engagement.institutionId, institutionId), isNotNull(engagement.matchRequestId)));

    const attachedIds = attached
      .map((row) => row.id)
      .filter((id): id is string => id !== null);

    const stray = await tx
      .delete(matchRequest)
      .where(
        and(ours, attachedIds.length > 0 ? notInArray(matchRequest.id, attachedIds) : undefined),
      )
      .returning({ id: matchRequest.id });

    return { engagements: engagementIds.length, requests: stray.length };
  });
}
