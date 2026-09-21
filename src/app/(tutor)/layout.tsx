import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { requireActor } from "@/server/modules/identity/actor";

export default async function TutorLayout({ children }: { children: ReactNode }) {
  const actor = await requireActor();

  return (
    <AppShell surface="tutor" actor={actor} nav={actor.tutorProfileId !== null}>
      {children}
    </AppShell>
  );
}
