import { after } from "next/server";

import { notifySessionChanges } from "./dispatch";

export function notifySessionChangesSoon(institutionId: string): void {
  after(() =>
    notifySessionChanges(institutionId).catch((error) =>
      console.error("[notifications] session changes not sent", error),
    ),
  );
}
