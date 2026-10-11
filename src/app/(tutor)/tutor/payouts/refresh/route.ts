import { onboardingLink } from "@/server/modules/billing/connect";
import { requireTutor } from "@/server/modules/identity/actor";

export async function GET() {
  const actor = await requireTutor();
  return Response.redirect(await onboardingLink(actor), 303);
}
