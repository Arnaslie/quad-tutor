"use server";

import { resetTestUsers, type ResetResult } from "@/server/db/personas/ops";
import { currentOperator } from "@/server/modules/identity/actor";

export async function resetTestUsersAction(): Promise<ResetResult> {
  return resetTestUsers(await currentOperator());
}
