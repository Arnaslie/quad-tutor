import { and, asc, eq, like, sql, type SQL } from "drizzle-orm";

import { auth } from "@/server/auth";
import { PERSONA_PREFIX } from "@/server/modules/billing/fixtures";
import type { OperatorActor } from "@/server/modules/identity/actor";

import { db } from "../index";
import { escapeLike } from "../like";
import { studentProfile, tutorProfile, user } from "../schema";

import { testPersonasOn } from "./lock";
import type { PersonaSummary } from "./people";
import { resetPersonas } from "./reset";
import { ResetRefused } from "./wipe";

type Refused = { status: "refused"; message: string };
export type ResetResult = { status: "done"; personas: PersonaSummary[] } | Refused;
export type SignInLinkResult = { status: "sent" } | Refused;
export type TestUser = Pick<PersonaSummary, "email" | "role">;

function gate(operator: OperatorActor | null, action: string): OperatorActor | Refused {
  if (!operator?.operatorInstitutionIds.includes(operator.institutionId)) {
    return { status: "refused", message: `Only an operator on this campus can ${action}.` };
  }
  if (!testPersonasOn()) return { status: "refused", message: "Test users are turned off here." };
  return operator;
}

async function testUsersOn(institutionId: string, only?: SQL): Promise<TestUser[]> {
  const rows = await db
    .select({ email: user.email, tutor: tutorProfile.id })
    .from(user)
    .innerJoin(studentProfile, eq(studentProfile.userId, user.id))
    .leftJoin(tutorProfile, eq(tutorProfile.userId, user.id))
    .where(and(eq(studentProfile.institutionId, institutionId), like(user.id, `${escapeLike(PERSONA_PREFIX)}%`), only))
    .orderBy(asc(user.email));
  return rows.map(({ email, tutor }) => ({ email, role: tutor ? "tutor" : "student" }));
}

export async function resetTestUsers(caller: OperatorActor | null): Promise<ResetResult> {
  const operator = gate(caller, "reset test users");
  if ("status" in operator) return operator;

  try {
    console.info(`[personas] ${operator.userId} is resetting test users on ${operator.institutionId}`);
    const personas = await resetPersonas({ institutionId: operator.institutionId });
    return { status: "done", personas };
  } catch (error) {
    if (error instanceof ResetRefused) return { status: "refused", message: error.message };
    throw error;
  }
}

export async function testUsersFor(caller: OperatorActor | null): Promise<TestUser[]> {
  const operator = gate(caller, "see test users");
  return "status" in operator ? [] : testUsersOn(operator.institutionId);
}

export async function sendTestUserSignInLink(
  caller: OperatorActor | null,
  email: string,
  headers: Headers,
): Promise<SignInLinkResult> {
  const operator = gate(caller, "send sign-in links to test users");
  if ("status" in operator) return operator;

  const [found] = await testUsersOn(operator.institutionId, sql`lower(${user.email}) = ${email.trim().toLowerCase()}`);
  if (!found) return { status: "refused", message: "That is not a test user on your campus." };

  console.info(`[personas] ${operator.userId} sent a sign-in link to ${found.email}`);
  await auth.api.signInMagicLink({ body: { email: found.email, callbackURL: "/courses" }, headers });
  return { status: "sent" };
}
