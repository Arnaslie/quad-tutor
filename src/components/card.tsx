import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

const SHELL = "rounded-2xl border border-border bg-surface";

/** A plain container. `padded={false}` when the card holds its own list rows. */
export function Card({
  padded = true,
  className = "",
  children,
}: {
  padded?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`${SHELL} ${padded ? "p-4 sm:p-5" : ""} ${className}`.trim()}>
      {children}
    </div>
  );
}

/**
 * The tappable version — a tutor in the deck, a course in the picker. The whole
 * card is the hit target, which on a phone is the difference between one thumb
 * tap and three.
 */
export function CardLink({
  padded = true,
  className = "",
  children,
  ...props
}: ComponentProps<typeof Link> & { padded?: boolean }) {
  return (
    <Link
      className={`${SHELL} ${padded ? "p-4 sm:p-5" : ""} block transition-colors hover:border-accent/40 hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background ${className}`.trim()}
      {...props}
    >
      {children}
    </Link>
  );
}
