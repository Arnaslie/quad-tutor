import { eq } from "drizzle-orm";

import { db } from "../index";
import { escapeLike } from "../like";
import { institution, institutionEmail, studentProfile, tutorProfile, user } from "../schema";

import type { KycStatus } from "@/server/modules/billing/kyc";
import { PERSONA_PREFIX } from "@/server/modules/billing/fixtures";
import type { Actor, TutorActor } from "@/server/modules/identity/actor";

const INBOX = { local: "arnutislie12", domain: "gmail.com" };

export type PersonaCampus = { institutionId: string; testRun?: string };

export type PersonaSummary = { key: string; email: string; role: "tutor" | "student"; state: string };

function handle(campus: PersonaCampus, key: string): string {
  return campus.testRun ? `${key}.${campus.testRun}` : key;
}

export async function campusBySlug(slug: string): Promise<PersonaCampus> {
  const [campus] = await db.select({ id: institution.id }).from(institution).where(eq(institution.slug, slug));
  if (!campus) throw new Error(`No campus "${slug}" — run npm run db:catalog first.`);
  return { institutionId: campus.id };
}

export function personaUserId(campus: PersonaCampus, key: string): string {
  return `${PERSONA_PREFIX}${handle(campus, key)}`;
}

export function personaEmail(campus: PersonaCampus, key: string): string {
  return `${INBOX.local}+${handle(campus, key)}@${INBOX.domain}`;
}

export function testRunEmails(testRun: string): string {
  return `${escapeLike(INBOX.local)}+%.${escapeLike(testRun)}@${escapeLike(INBOX.domain)}`;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function insertPersona(tx: Tx, campus: PersonaCampus, key: string, name: string): Promise<Actor> {
  const userId = personaUserId(campus, key);
  const email = personaEmail(campus, key);
  const { institutionId } = campus;

  await tx.insert(user).values({ id: userId, name, email, emailVerified: true });
  await tx.insert(institutionEmail).values({ email, institutionId });
  const [profile] = await tx
    .insert(studentProfile)
    .values({ userId, institutionId })
    .returning({ id: studentProfile.id });

  return { userId, name, email, institutionId, studentProfileId: profile.id, tutorProfileId: null };
}

export function createPersona(campus: PersonaCampus, key: string, name: string): Promise<Actor> {
  return db.transaction((tx) => insertPersona(tx, campus, key, name));
}

export function createTutorPersona(
  campus: PersonaCampus,
  persona: { key: string; name: string; headline: string; kyc: KycStatus },
): Promise<TutorActor> {
  return db.transaction(async (tx) => {
    const actor = await insertPersona(tx, campus, persona.key, persona.name);
    const [profile] = await tx
      .insert(tutorProfile)
      .values({
        userId: actor.userId,
        institutionId: campus.institutionId,
        headline: persona.headline,
        kycStatus: persona.kyc,
      })
      .returning({ id: tutorProfile.id });
    return { ...actor, tutorProfileId: profile.id };
  });
}
