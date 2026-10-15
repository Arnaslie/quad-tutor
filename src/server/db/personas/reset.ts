import { and, eq, inArray, like, sql, type AnyColumn } from "drizzle-orm";

import { db } from "../index";
import { escapeLike } from "../like";
import { engagement, matchRequest, sessionBooking, studentProfile, tutorCourse, tutorProfile } from "../schema";

import { PERSONA_PREFIX } from "@/server/modules/billing/fixtures";
import { releaseRatings } from "@/server/modules/ratings/release";
import { refreshScores } from "@/server/modules/scoring/stats";

import type { PersonaCampus, PersonaSummary } from "./people";
import { buildTutorPersonas } from "./tutors";
import { wipePersonas } from "./wipe";

const BUILDERS: readonly ((campus: PersonaCampus) => Promise<PersonaSummary[]>)[] = [buildTutorPersonas];

const stamp = (column: AnyColumn) => sql`coalesce(${column}, now())`;

/** History is not news: marks every persona row as already notified, so the email sweep never mails it. */
async function silenceHistory(institutionId: string): Promise<void> {
  const personaStudents = db
    .select({ id: studentProfile.id })
    .from(studentProfile)
    .where(and(eq(studentProfile.institutionId, institutionId), like(studentProfile.userId, `${escapeLike(PERSONA_PREFIX)}%`)));
  const personaTutors = db
    .select({ id: tutorProfile.id })
    .from(tutorProfile)
    .where(and(eq(tutorProfile.institutionId, institutionId), like(tutorProfile.userId, `${escapeLike(PERSONA_PREFIX)}%`)));
  const personaEngagements = db
    .select({ id: engagement.id })
    .from(engagement)
    .where(and(eq(engagement.institutionId, institutionId), inArray(engagement.studentProfileId, personaStudents)));

  await db
    .update(matchRequest)
    .set({ tutorNotifiedAt: stamp(matchRequest.tutorNotifiedAt), studentNotifiedAt: stamp(matchRequest.studentNotifiedAt) })
    .where(and(eq(matchRequest.institutionId, institutionId), inArray(matchRequest.studentProfileId, personaStudents)));
  await db
    .update(sessionBooking)
    .set({
      bookedNotifiedAt: stamp(sessionBooking.bookedNotifiedAt),
      remindedAt: stamp(sessionBooking.remindedAt),
      cancelNotifiedAt: stamp(sessionBooking.cancelNotifiedAt),
      answerPromptedAt: stamp(sessionBooking.answerPromptedAt),
      settledNotifiedAt: stamp(sessionBooking.settledNotifiedAt),
      notifiedLocation: sql`${sessionBooking.location}`,
    })
    .where(and(eq(sessionBooking.institutionId, institutionId), inArray(sessionBooking.engagementId, personaEngagements)));
  await db
    .update(tutorCourse)
    .set({ decisionNotifiedAt: stamp(tutorCourse.decisionNotifiedAt) })
    .where(and(eq(tutorCourse.institutionId, institutionId), inArray(tutorCourse.tutorProfileId, personaTutors)));
}

/** Deletes every persona on the campus and rebuilds them all, so running it twice gives the same state. */
export async function resetPersonas(campus: PersonaCampus): Promise<PersonaSummary[]> {
  await wipePersonas(campus.institutionId);
  const built: PersonaSummary[] = [];
  for (const build of BUILDERS) built.push(...(await build(campus)));
  await releaseRatings(campus.institutionId);
  await refreshScores(campus.institutionId);
  await silenceHistory(campus.institutionId);
  return built;
}
