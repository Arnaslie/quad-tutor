import { Button } from "@/components/button";

import { blockAction } from "../actions";
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
        <ReportForm threadId={threadId} />

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
