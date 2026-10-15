import type { OperatorActor } from "@/server/modules/identity/actor";

import { testPersonasOn } from "./lock";
import type { PersonaSummary } from "./people";
import { resetPersonas } from "./reset";
import { ResetRefused } from "./wipe";

export type ResetResult = { status: "done"; personas: PersonaSummary[] } | { status: "refused"; message: string };

export async function resetTestUsers(operator: OperatorActor | null): Promise<ResetResult> {
  if (!operator?.operatorInstitutionIds.includes(operator.institutionId)) {
    return { status: "refused", message: "Only an operator on this campus can reset test users." };
  }
  if (!testPersonasOn()) return { status: "refused", message: "Test users are turned off here." };

  try {
    console.info(`[personas] ${operator.userId} is resetting test users on ${operator.institutionId}`);
    const personas = await resetPersonas({ institutionId: operator.institutionId });
    return { status: "done", personas };
  } catch (error) {
    if (error instanceof ResetRefused) return { status: "refused", message: error.message };
    throw error;
  }
}
