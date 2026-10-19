"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { choosePayoutSpeed, onboardingLink } from "@/server/modules/billing/connect";
import { PAYOUT_SPEEDS } from "@/server/modules/billing/payout-speed";
import { requireTutor } from "@/server/modules/identity/actor";

import { PAYOUTS_HREF } from "./stage";

export async function startOnboarding(): Promise<void> {
  const actor = await requireTutor();
  redirect(await onboardingLink(actor));
}

export async function pickPayoutSpeed(formData: FormData): Promise<void> {
  const actor = await requireTutor();
  const speed = z.enum(PAYOUT_SPEEDS).safeParse(formData.get("speed"));
  if (!speed.success) return;
  await choosePayoutSpeed(actor, speed.data);
  revalidatePath(PAYOUTS_HREF);
}
