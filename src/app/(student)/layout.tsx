import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { requireActor } from "@/server/modules/identity/actor";

export default async function StudentLayout({ children }: { children: ReactNode }) {
  const actor = await requireActor();

  return (
    <AppShell surface="student" actor={actor}>
      {children}
    </AppShell>
  );
}
