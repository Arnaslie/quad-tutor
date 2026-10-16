import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { testPersonasOn } from "@/server/db/personas/lock";
import { requireOperator } from "@/server/modules/identity/actor";

export default async function OpsLayout({ children }: { children: ReactNode }) {
  const operator = await requireOperator();
  const more = testPersonasOn() ? [{ href: "/ops/test-users", label: "Test users", icon: "user" as const }] : [];

  return (
    <AppShell surface="ops" actor={operator} more={more}>
      {children}
    </AppShell>
  );
}
