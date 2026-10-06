import { Button } from "@/components/button";

import { blockAction, reportAction } from "../actions";
import { ReportForm } from "./report-form";

export function ThreadTools({
  threadId,
  otherName,
  blockedByMe,
}: {
  threadId: string;
  otherName: string;
  blockedByMe: boolean;
}) {
  return (
    <details className="group rounded-2xl border border-border bg-surface">
      <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-medium text-muted marker:content-none">
        Report or block
      </summary>
      <div className="flex flex-col gap-6 border-t border-border p-4">
        <ReportForm
          action={reportAction}
          field="threadId"
          value={threadId}
          label="Report this conversation"
          hint="Staff can read a conversation only once it is reported."
          sent="Reported. Someone on the Quad Tutor team will read this conversation."
        />

        <form action={blockAction} className="flex flex-col items-start gap-2">
          <input type="hidden" name="threadId" value={threadId} />
          <input type="hidden" name="blocked" value={blockedByMe ? "false" : "true"} />
          <p className="text-sm text-muted">
            {blockedByMe
              ? `Unblocking lets you and ${otherName} message each other again.`
              : `Blocking stops messages both ways, and you won't be matched with ${otherName} again.`}
          </p>
          <Button type="submit" variant={blockedByMe ? "secondary" : "danger"}>
            {blockedByMe ? `Unblock ${otherName}` : `Block ${otherName}`}
          </Button>
        </form>
      </div>
    </details>
  );
}
