import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { requireActor } from "@/server/modules/identity/actor";
import { unreadTotal } from "@/server/modules/messaging/threads";

export default async function StudentLayout({ children }: { children: ReactNode }) {
  const actor = await requireActor();

  return (
    <AppShell surface="student" actor={actor} unread={await unreadTotal(actor)}>
      {children}
    </AppShell>
  );
}
