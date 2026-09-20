import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { requireActor } from "@/server/modules/identity/actor";

/**
 * Everything under here is signed-in student surface. `requireActor` redirects
 * to `/sign-in`, so no page below this needs to think about the signed-out case.
 */
export default async function StudentLayout({ children }: { children: ReactNode }) {
  const actor = await requireActor();

  return (
    <AppShell surface="student" actor={actor}>
      {children}
    </AppShell>
  );
}
