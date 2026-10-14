import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "../index";
import {
  courseCodeAlias,
  courseOffering,
  matchRequest,
  term,
  tutorCourse,
  tutorProfile,
} from "../schema";

import { upcomingExams } from "@/server/modules/catalog/courses";
import { buyPackage } from "@/server/modules/engagements/buy-and-pay";
import { slotsForRequest } from "@/server/modules/engagements/purchase";
import type { Actor, TutorActor } from "@/server/modules/identity/actor";
import { acceptRequest, requestTutors } from "@/server/modules/matching/requests";

/** A current-term offering and the tutors asked for it; the first tutor is the one who accepts. */
export type Target = {
  courseOfferingId: string;

  tutorCourseIds: string[];
  accepterTutorCourseId: string;
};

export async function resolveTarget(cast: {
  code: string;
  section: string;

  tutors: string[];
}): Promise<Target> {
  const offerings = await db
    .select({ id: courseOffering.id, courseId: courseOffering.courseId })
    .from(courseOffering)
    .innerJoin(
      courseCodeAlias,
      and(
        eq(courseCodeAlias.courseId, courseOffering.courseId),
        isNull(courseCodeAlias.validToTermId),
      ),
    )
    .innerJoin(term, eq(term.id, courseOffering.termId))
    .where(
      and(
        eq(courseCodeAlias.code, cast.code),
        eq(courseOffering.section, cast.section),
        sql`current_date between ${term.startsOn} and ${term.endsOn}`,
      ),
    )
    .limit(1);

  const offering = offerings.at(0);
  if (!offering) throw new Error(`no ${cast.code}-${cast.section} offering — seed first`);

  const userIds = cast.tutors;
  const rows = await db
    .select({ id: tutorCourse.id, userId: tutorProfile.userId })
    .from(tutorCourse)
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .where(
      and(
        eq(tutorCourse.courseId, offering.courseId),
        eq(tutorCourse.status, "active"),
        inArray(tutorProfile.userId, userIds),
      ),
    );

  const byUser = new Map(rows.map((row) => [row.userId, row.id]));
  const missing = userIds.filter((id) => !byUser.has(id));
  if (missing.length > 0) {
    throw new Error(`not tutoring ${cast.code}: ${missing.join(", ")} — seed first`);
  }

  return {
    courseOfferingId: offering.id,
    tutorCourseIds: userIds.map((id) => byUser.get(id)!),
    accepterTutorCourseId: byUser.get(userIds[0])!,
  };
}

export async function openPackage(params: {
  student: Actor;
  tutor: TutorActor;
  target: Target;
  slotsNeeded: number;
}) {
  const { student, tutor, target, slotsNeeded } = params;

  const asked = await requestTutors({
    actor: student,
    courseOfferingId: target.courseOfferingId,
    tutorCourseIds: target.tutorCourseIds,
    kind: "exam_anchored",
  });

  const pending = await db
    .select({ id: matchRequest.id })
    .from(matchRequest)
    .where(
      and(
        eq(matchRequest.studentProfileId, student.studentProfileId),
        eq(matchRequest.tutorCourseId, target.accepterTutorCourseId),
        eq(matchRequest.status, "pending"),
      ),
    )
    .limit(1);

  const requestId = pending.at(0)?.id;
  if (!requestId) throw new Error(`no pending request for ${tutor.userId}`);

  await acceptRequest({ tutor, requestId });

  const slots = await slotsForRequest({ actor: student, requestId });
  if (slots.length < slotsNeeded) {
    throw new Error(`${tutor.userId} has ${slots.length} open slot(s), need ${slotsNeeded}`);
  }

  const exams = await upcomingExams(target.courseOfferingId);
  const anchor = exams.at(0) ?? null;

  const { engagementId } = await buyPackage({
    actor: student,
    requestId,
    kind: "exam_anchored",
    anchorExamId: anchor?.id ?? null,
    slotStartsAt: slots[0],
  });

  return { engagementId, asked, anchor };
}
