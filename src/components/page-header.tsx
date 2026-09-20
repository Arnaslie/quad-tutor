import type { ReactNode } from "react";

/**
 * The top of every screen. `eyebrow` carries the course context ("MATH 125 ·
 * Prof. Reed") — on this product that line is the whole value proposition, so
 * it gets a permanent slot rather than being written freehand per screen.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="flex flex-col gap-1">
        {eyebrow ? (
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {title}
        </h1>
        {description ? (
          <p className="max-w-prose text-base text-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}
