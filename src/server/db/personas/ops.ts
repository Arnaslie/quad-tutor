import type { OperatorActor } from "@/server/modules/identity/actor";

import type { PersonaSummary } from "./people";
import { resetPersonas } from "./reset";
import { ResetRefused } from "./wipe";

export type ResetResult = { status: "done"; personas: PersonaSummary[] } | { status: "refused"; message: string };

export const testPersonasOn = () => process.env.TEST_PERSONAS === "on";

export async function resetTestUsers(operator: OperatorActor | null): Promise<ResetResult> {
  if (!operator?.operatorInstitutionIds.includes(operator.institutionId)) {
    return { status: "refused", message: "Only an operator on this campus can reset test users." };
  }
  if (!testPersonasOn()) return { status: "refused", message: "Test users are turned off here." };

  try {
    const personas = await resetPersonas({ institutionId: operator.institutionId });
    console.info(`[personas] ${operator.userId} reset ${personas.length} test users on ${operator.institutionId}`);
    return { status: "done", personas };
  } catch (error) {
    if (error instanceof ResetRefused) return { status: "refused", message: error.message };
    throw error;
  }
}
