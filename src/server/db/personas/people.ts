import { db } from "../index";
import { institutionEmail, studentProfile, tutorProfile, user } from "../schema";

import type { KycStatus } from "@/server/modules/billing/kyc";
import { PERSONA_PREFIX } from "@/server/modules/billing/fixtures";
import type { Actor, TutorActor } from "@/server/modules/identity/actor";

const INBOX = { local: "arnutislie12", domain: "gmail.com" };

export type PersonaCampus = { institutionId: string; testRun?: string };

export type PersonaSummary = { key: string; email: string; role: "tutor" | "student"; state: string };

function handle(campus: PersonaCampus, key: string): string {
  return campus.testRun ? `${key}.${campus.testRun}` : key;
}

export function personaUserId(campus: PersonaCampus, key: string): string {
  return `${PERSONA_PREFIX}${handle(campus, key)}`;
}

export function personaEmail(campus: PersonaCampus, key: string): string {
  return `${INBOX.local}+${handle(campus, key)}@${INBOX.domain}`;
}

export async function createPersona(campus: PersonaCampus, key: string, name: string): Promise<Actor> {
  const userId = personaUserId(campus, key);
  const email = personaEmail(campus, key);
  const { institutionId } = campus;

  await db.insert(user).values({ id: userId, name, email, emailVerified: true });
  await db.insert(institutionEmail).values({ email, institutionId });
  const [profile] = await db
    .insert(studentProfile)
    .values({ userId, institutionId })
    .returning({ id: studentProfile.id });

  return { userId, name, email, institutionId, studentProfileId: profile.id, tutorProfileId: null };
}

export async function createTutorPersona(
  campus: PersonaCampus,
  persona: { key: string; name: string; headline: string; kyc: KycStatus },
): Promise<TutorActor> {
  const actor = await createPersona(campus, persona.key, persona.name);
  const [profile] = await db
    .insert(tutorProfile)
    .values({
      userId: actor.userId,
      institutionId: campus.institutionId,
      headline: persona.headline,
      kycStatus: persona.kyc,
    })
    .returning({ id: tutorProfile.id });
  return { ...actor, tutorProfileId: profile.id };
}
