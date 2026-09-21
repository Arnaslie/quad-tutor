import Link from "next/link";

import { Icon } from "./icons";
import type { Surface } from "./nav-items";

const LINK =
  "inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-muted transition-colors hover:bg-surface-sunken hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:px-3";

export function SurfaceSwitch({
  surface,
  isTutor,
}: {
  surface: Surface;
  isTutor: boolean;
}) {
  if (surface === "tutor") {
    return (
      <Link href="/courses" className={LINK}>
        <Icon name="book" className="size-[18px]" />
        <span className="hidden sm:inline">Student view</span>
        <span className="sm:hidden">Student</span>
      </Link>
    );
  }

  if (!isTutor) {
    return (
      <Link href="/tutor/start" className={LINK}>
        <Icon name="cap" className="size-[18px]" />
        <span className="hidden sm:inline">Become a tutor</span>
        <span className="sm:hidden">Tutor</span>
      </Link>
    );
  }

  return (
    <Link href="/tutor" className={LINK}>
      <Icon name="cap" className="size-[18px]" />
      <span className="hidden sm:inline">Tutor view</span>
      <span className="sm:hidden">Tutor</span>
    </Link>
  );
}
