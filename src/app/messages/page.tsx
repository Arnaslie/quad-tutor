import type { Metadata } from "next";

import { ButtonLink } from "@/components/button";
import { CardLink } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { formatDayTime } from "@/components/format";
import { PageHeader } from "@/components/page-header";
import { requireActor } from "@/server/modules/identity/actor";
import { inboxFor } from "@/server/modules/messaging/threads";

export const metadata: Metadata = { title: "Messages" };

export default async function MessagesPage() {
  const actor = await requireActor();
  const threads = await inboxFor(actor);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Messages"
        description="One conversation per tutor and course. It opens when a request goes out."
      />

      {threads.length === 0 ? (
        <EmptyState
          icon="chat"
          title="No conversations yet"
          description="You can message a tutor once you have asked them for help, and they can message you back."
          action={<ButtonLink href="/courses">Find a tutor</ButtonLink>}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {threads.map((thread) => (
            <li key={thread.id}>
              <CardLink
                href={`/messages/${thread.id}`}
                prefetch={false}
                className="flex items-start gap-3"
              >
                <div className="min-w-0 flex-1">
                  <p className={thread.unread > 0 ? "font-semibold" : "font-medium"}>
                    {thread.otherName}
                  </p>
                  <p className="truncate text-sm text-muted">
                    {thread.courseLabel} · {thread.side === "tutor" ? "Student" : "Tutor"}
                  </p>
                  <p className="truncate pt-1 text-sm text-muted">
                    {thread.preview ?? "No messages yet"}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {thread.lastAt ? (
                    <span className="text-xs text-muted">{formatDayTime(thread.lastAt)}</span>
                  ) : null}
                  {thread.unread > 0 ? (
                    <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground">
                      {thread.unread} new
                    </span>
                  ) : null}
                </div>
              </CardLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
