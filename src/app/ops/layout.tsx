import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { requireOperator } from "@/server/modules/identity/actor";

export default async function OpsLayout({ children }: { children: ReactNode }) {
  const operator = await requireOperator();

  return (
    <AppShell surface="ops" actor={operator}>
      {children}
    </AppShell>
  );
}
