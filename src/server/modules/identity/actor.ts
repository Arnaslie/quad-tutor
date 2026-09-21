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

  tutorProfileId: string | null;
};

export type TutorActor = Actor & { tutorProfileId: string };

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
