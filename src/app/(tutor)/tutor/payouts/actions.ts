"use server";

import { redirect } from "next/navigation";

import { onboardingLink } from "@/server/modules/billing/connect";
import { requireTutor } from "@/server/modules/identity/actor";

export async function startOnboarding(): Promise<void> {
  const actor = await requireTutor();
  redirect(await onboardingLink(actor));
}
