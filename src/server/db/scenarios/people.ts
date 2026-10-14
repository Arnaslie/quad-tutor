import { eq } from "drizzle-orm";

import { db } from "../index";
import { studentProfile, tutorProfile, user } from "../schema";

import type { Actor, TutorActor } from "@/server/modules/identity/actor";

export async function actorFor(userId: string): Promise<Actor> {
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
    .where(eq(user.id, userId))
    .limit(1);

  const actor = rows.at(0);
  if (!actor) throw new Error(`no seeded user ${userId} — run npm run db:seed first`);
  return actor;
}

export async function tutorActorFor(userId: string): Promise<TutorActor> {
  const actor = await actorFor(userId);
  if (!actor.tutorProfileId) throw new Error(`${userId} has no tutor profile`);
  return actor as TutorActor;
}

export async function userIdByEmail(email: string): Promise<string> {
  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (!row) throw new Error(`no user ${email} — sign in on the app once first`);
  return row.id;
}
