import Link from "next/link";

import { Icon } from "./icons";

export function MessagesLink({ unread }: { unread: number }) {
  return (
    <Link
      href="/messages"
      aria-label={unread > 0 ? `Messages, ${unread} unread` : "Messages"}
      className="relative inline-flex size-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-sunken hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Icon name="chat" className="size-[18px]" />
      {unread > 0 ? (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-foreground">
          {unread > 9 ? "9+" : unread}
        </span>
      ) : null}
    </Link>
  );
}
