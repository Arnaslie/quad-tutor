import { redirect } from "next/navigation";

import { currentActor } from "@/server/modules/identity/actor";

/**
 * The root is a switch, not a landing page. A signed-in student lands on the
 * course picker because course selection *is* the intake — everything the course
 * code already answers has been cut from the funnel.
 */
export default async function Home() {
  const actor = await currentActor();
  redirect(actor ? "/courses" : "/sign-in");
}
