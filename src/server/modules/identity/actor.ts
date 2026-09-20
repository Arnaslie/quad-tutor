/**
 * Who is acting, and on which campus.
 *
 * Every server action begins here. `institutionId` is the tenant key: it is read
 * from the signed-in user's profile and passed down, never accepted from the
 * client. A query that takes a campus id from a form field is a cross-campus
 * leak waiting to happen.
 *
 * A user is a student by default — the student profile is created with the user
 * row (see `src/server/auth.ts`). Becoming a tutor is an explicit act, because
 * on a peer campus the same person is routinely both.
 */

import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";

import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { studentProfile, tutorProfile, user } from "@/server/db/schema";

export type Actor = {
  userId: string;
  name: string;
  email: string;
  institutionId: string;
  studentProfileId: string;
  /** Null until the user opts into tutoring. */
  tutorProfileId: string | null;
};

export type TutorActor = Actor & { tutorProfileId: string };

/**
 * `cache` dedupes this across a single render pass — a layout and three nested
 * server components asking "who is this?" costs one session lookup, not four.
 */
export const currentActor = cache(async (): Promise<Actor | null> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;

  const rows = await db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      institutionId: studentProfile.institutionId,
      studentProfileId: studentProfile.id,
      tutorProfileId: tutorProfile.id,
    })
    .from(user)
    .innerJoin(studentProfile, eq(studentProfile.userId, user.id))
    .leftJoin(tutorProfile, eq(tutorProfile.userId, user.id))
    .where(eq(user.id, session.user.id))
    .limit(1);

  return rows.at(0) ?? null;
});

export async function requireActor(): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) redirect("/sign-in");
  return actor;
}

export async function requireTutor(): Promise<TutorActor> {
  const actor = await requireActor();
  if (!actor.tutorProfileId) redirect("/tutor/start");
  return actor as TutorActor;
}

/**
 * Idempotent. KYC stays `not_started` here by design — it is deferred to the
 * first accepted request so the friction does not land on the bottleneck.
 */
export async function becomeTutor(actor: Actor): Promise<string> {
  if (actor.tutorProfileId) return actor.tutorProfileId;

  const existing = await db
    .select({ id: tutorProfile.id })
    .from(tutorProfile)
    .where(eq(tutorProfile.userId, actor.userId))
    .limit(1);

  const found = existing.at(0);
  if (found) return found.id;

  const [created] = await db
    .insert(tutorProfile)
    .values({ userId: actor.userId, institutionId: actor.institutionId })
    .returning({ id: tutorProfile.id });

  return created.id;
}

/**
 * Confirms a tutor profile belongs to this campus before anything is written
 * against it. Callers that already hold a `TutorActor` do not need this; it
 * exists for the paths that resolve a tutor from a row rather than a session.
 */
export async function assertTutorOnCampus(
  tutorProfileId: string,
  institutionId: string,
): Promise<void> {
  const rows = await db
    .select({ id: tutorProfile.id })
    .from(tutorProfile)
    .where(
      and(
        eq(tutorProfile.id, tutorProfileId),
        eq(tutorProfile.institutionId, institutionId),
      ),
    )
    .limit(1);

  if (!rows.at(0)) throw new Error("Tutor is not on this campus.");
}
