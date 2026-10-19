"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { cashOut, type CashOutResult } from "@/server/modules/billing/cash-out";
import { choosePayoutSpeed, onboardingLink } from "@/server/modules/billing/connect";
import { PAYOUT_SPEEDS } from "@/server/modules/billing/payout-speed";
import { formatMinor } from "@/server/modules/billing/pricing";
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

export type CashOutState = { status: "idle" } | { status: "sent" | "error"; message: string };

const cashOutInput = z.object({ netMinor: z.coerce.number().int().positive(), requestId: z.uuid() });

function cashOutState(result: CashOutResult): CashOutState {
  switch (result.status) {
    case "sent":
      return { status: "sent", message: `${formatMinor(result.netMinor, result.currency)} is on its way. It usually lands in minutes.` };
    case "changed":
      return { status: "error", message: "Your balance changed since you opened this page. Check the new amount and send again." };
    case "busy":
      return { status: "error", message: "That cash-out is already being sent." };
    case "refused":
      return { status: "error", message: "Stripe couldn't send that. Your pay still goes out on your usual schedule." };
    case "retry":
      return { status: "error", message: "We couldn't reach Stripe. Try again in a minute." };
    case "unavailable":
      return { status: "error", message: "There's nothing to cash out right now. If you just cashed out, it's on its way. The rest goes out on your usual schedule." };
  }
}

export async function cashOutNow(_previous: CashOutState, formData: FormData): Promise<CashOutState> {
  const actor = await requireTutor();
  const input = cashOutInput.safeParse({ netMinor: formData.get("netMinor"), requestId: formData.get("requestId") });
  if (!input.success) return { status: "error", message: "Reload the page and try again." };
  const result = await cashOut(actor, input.data);
  if (result.status !== "retry") revalidatePath(PAYOUTS_HREF);
  return cashOutState(result);
}
