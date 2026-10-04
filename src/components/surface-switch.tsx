import Link from "next/link";

import { Icon, type IconName } from "./icons";
import type { Surface } from "./nav-items";

const SEGMENT =
  "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function Segment({
  href,
  icon,
  label,
  hint,
  active,
}: {
  href: string;
  icon: IconName;
  label: string;
  hint?: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`${SEGMENT} ${
        active
          ? "bg-surface text-foreground shadow-sm"
          : "text-muted hover:text-foreground"
      }`}
    >
      <Icon name={icon} className="hidden size-4 sm:block" />
      {label}
      {hint ? <span className="sr-only">{hint}</span> : null}
    </Link>
  );
}

export function SurfaceSwitch({
  view,
  isTutor,
}: {
  view: Surface | null;
  isTutor: boolean;
}) {
  return (
    <nav
      aria-label="View"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-surface-sunken p-0.5"
    >
      <Segment
        href="/courses"
        icon="book"
        label="Student"
        active={view === "student"}
      />
      <Segment
        href={isTutor ? "/tutor" : "/tutor/start"}
        icon="cap"
        label="Tutor"
        hint={isTutor ? undefined : ", become a tutor"}
        active={view === "tutor"}
      />
    </nav>
  );
}
