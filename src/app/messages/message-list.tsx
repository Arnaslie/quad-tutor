import { formatDayTime } from "@/components/format";
import type { ThreadMessage } from "@/server/modules/messaging/threads";

export function MessageList({ messages, empty }: { messages: ThreadMessage[]; empty: string }) {
  if (messages.length === 0) {
    return <p className="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted">{empty}</p>;
  }

  return (
    <ol className="flex flex-col gap-3" aria-label="Messages">
      {messages.map((item) => (
        <li
          key={item.id}
          className={`flex max-w-[85%] flex-col gap-1 ${item.mine ? "items-end self-end" : "items-start self-start"}`}
        >
          <p
            className={`whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-base ${
              item.mine ? "bg-accent text-accent-foreground" : "border border-border bg-surface"
            }`}
          >
            {item.body}
          </p>
          <p className="px-1 text-xs text-muted">
            {item.mine ? "You" : item.senderName} · {formatDayTime(item.sentAt)}
          </p>
        </li>
      ))}
    </ol>
  );
}
