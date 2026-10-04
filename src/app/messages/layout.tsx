import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { requireActor } from "@/server/modules/identity/actor";
import { unreadTotal } from "@/server/modules/messaging/threads";

export default async function MessagesLayout({ children }: { children: ReactNode }) {
  const actor = await requireActor();

  return (
    <AppShell surface="student" actor={actor} nav={false} unread={await unreadTotal(actor)}>
      {children}
    </AppShell>
  );
}
