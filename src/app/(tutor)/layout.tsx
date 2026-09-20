import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { requireActor } from "@/server/modules/identity/actor";

/**
 * `requireActor`, not `requireTutor` — `/tutor/start` lives inside this group
 * and is where `requireTutor` redirects, so gating the layout on a tutor
 * profile would bounce a would-be tutor in a loop. Feature pages call
 * `requireTutor` themselves.
 */
export default async function TutorLayout({ children }: { children: ReactNode }) {
  const actor = await requireActor();

  return (
    <AppShell surface="tutor" actor={actor} nav={actor.tutorProfileId !== null}>
      {children}
    </AppShell>
  );
}
