import { redirect } from "next/navigation";

import { currentActor } from "@/server/modules/identity/actor";

export default async function Home() {
  const actor = await currentActor();
  redirect(actor ? "/courses" : "/sign-in");
}
