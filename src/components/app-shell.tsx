import Link from "next/link";
import type { ReactNode } from "react";

import type { Actor } from "@/server/modules/identity/actor";
import { MessagesLink } from "./messages-link";
import { NAV, type Surface } from "./nav-items";
import { NavLink } from "./nav-link";
import { ProfileMenu } from "./profile-menu";
import { SurfaceSwitch } from "./surface-switch";

const HOME: Record<Surface, string> = {
  student: "/courses",
  tutor: "/tutor",
  ops: "/ops/verifications",
};

const BADGE: Partial<Record<Surface, string>> = { ops: "Ops" };

export function AppShell({
  surface,
  view = surface,
  actor,
  nav = true,
  unread,
  children,
}: {
  surface: Surface;
  view?: Surface | null;
  actor: Actor;

  nav?: boolean;
  unread?: number;
  children: ReactNode;
}) {
  const items = nav ? NAV[surface] : [];
  const home = HOME[surface];

  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-1 px-4 sm:gap-2">
          <Link
            href={home}
            className="shrink-0 rounded-lg text-sm font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:text-base"
          >
            Quad Tutor
          </Link>

          {BADGE[surface] ? (
            <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent">
              {BADGE[surface]}
            </span>
          ) : null}

          {items.length > 0 ? (
            <nav
              aria-label="Main"
              className="ml-4 hidden items-center gap-1 md:flex"
            >
              {items.map((item) => (
                <NavLink key={item.href} item={item} style="inline" />
              ))}
            </nav>
          ) : null}

          <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
            {unread === undefined ? null : <MessagesLink unread={unread} />}
            <SurfaceSwitch view={view} isTutor={actor.tutorProfileId !== null} />
            <ProfileMenu name={actor.name} email={actor.email} />
          </div>
        </div>
      </header>

      <main
        className={`mx-auto w-full max-w-5xl flex-1 px-4 pt-6 sm:px-6 md:pb-12 md:pt-8 ${
          items.length > 0 ? "pb-28" : "pb-12"
        }`}
      >
        {children}
      </main>

      {items.length > 0 ? (
        <nav
          aria-label="Main"
          className="pb-safe fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 backdrop-blur md:hidden"
        >
          <div className="mx-auto flex w-full max-w-lg items-stretch gap-1 px-2 py-1">
            {items.map((item) => (
              <NavLink key={item.href} item={item} style="tab" />
            ))}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
