import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

const SHELL = "rounded-2xl border border-border bg-surface";

function interactiveClass(padded: boolean, className: string) {
  return `${SHELL} ${padded ? "p-4 sm:p-5" : ""} block transition-colors hover:border-accent/40 hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background ${className}`.trim();
}

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

export function CardLink({
  padded = true,
  className = "",
  children,
  ...props
}: ComponentProps<typeof Link> & { padded?: boolean }) {
  return (
    <Link className={interactiveClass(padded, className)} {...props}>
      {children}
    </Link>
  );
}

export function CardButton({
  padded = true,
  className = "",
  ...props
}: ComponentProps<"button"> & { padded?: boolean }) {
  return <button className={`${interactiveClass(padded, className)} w-full text-left`} {...props} />;
}
