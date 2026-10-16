import { after } from "next/server";

import { holdingPersonas } from "@/server/db/personas/lock";

import { notifySessionChanges } from "./dispatch";

export function notifySessionChangesSoon(institutionId: string): void {
  after(() =>
    holdingPersonas(institutionId, "send", () => notifySessionChanges(institutionId)).catch((error) =>
      console.error("[notifications] session changes not sent", error),
    ),
  );
}
