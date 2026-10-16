"use server";

import { headers } from "next/headers";
import { z } from "zod";

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
  const parsed = z.email().safeParse(email);
  if (!parsed.success) return { status: "refused", message: "That is not a test user on your campus." };
  return sendTestUserSignInLink(await currentOperator(), parsed.data, await headers());
}
