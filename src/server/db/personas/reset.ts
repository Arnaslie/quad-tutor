import { and, eq, inArray, like, sql, type AnyColumn } from "drizzle-orm";

import { db } from "../index";
import { escapeLike } from "../like";
import { engagement, matchRequest, sessionBooking, studentProfile, tutorCourse, tutorProfile } from "../schema";

import { PERSONA_PREFIX } from "@/server/modules/billing/fixtures";
import { releaseRatings } from "@/server/modules/ratings/release";
import { refreshScores } from "@/server/modules/scoring/stats";

import { holdingPersonas } from "./lock";
import type { PersonaCampus, PersonaSummary } from "./people";
import { buildStudentPersonas } from "./students";
import { buildTermPersonas } from "./term";
import { buildTutorPersonas } from "./tutors";
import { ResetRefused, wipePersonas } from "./wipe";

const BUILDERS: readonly ((campus: PersonaCampus) => Promise<PersonaSummary[]>)[] = [
  buildTutorPersonas,
  buildStudentPersonas,
  buildTermPersonas,
];

const stamp = (column: AnyColumn) => sql`coalesce(${column}, now())`;

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

export async function resetPersonas(campus: PersonaCampus): Promise<PersonaSummary[]> {
  const built = await holdingPersonas(campus.institutionId, "reset", async () => {
    await wipePersonas(campus.institutionId);
    const summaries = (await Promise.all(BUILDERS.map((build) => build(campus)))).flat();
    await releaseRatings(campus.institutionId);
    await refreshScores(campus.institutionId);
    await silenceHistory(campus.institutionId);
    return summaries;
  });
  if (!built) throw new ResetRefused("Test users are already being reset, or email is going out right now. Try again in a minute.");
  return built;
}
