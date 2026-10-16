"use server";

import { headers } from "next/headers";

import {
  resetTestUsers,
  sendTestUserSignInLink,
  type ResetResult,
  type SignInLinkResult,
} from "@/server/db/personas/ops";
import { currentOperator } from "@/server/modules/identity/actor";

export async function resetTestUsersAction(): Promise<ResetResult> {
  return resetTestUsers(await currentOperator());
}

export async function sendSignInLinkAction(email: string): Promise<SignInLinkResult> {
  return sendTestUserSignInLink(await currentOperator(), email, await headers());
}
