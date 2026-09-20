import Link from "next/link";
import type { ReactNode } from "react";

import type { Actor } from "@/server/modules/identity/actor";
import { NAV, type Surface } from "./nav-items";
import { NavLink } from "./nav-link";
import { SignOutButton } from "./sign-out-button";
import { SurfaceSwitch } from "./surface-switch";

/**
 * The frame both surfaces sit in: sticky header, one content column, and the
 * navigation — a bottom tab bar on a phone, inline in the header from `md` up.
 *
 * Both bars render the same `NAV` array, so a route cannot exist on one and be
 * missing from the other.
 */
export function AppShell({
  surface,
  actor,
  nav = true,
  children,
}: {
  surface: Surface;
  actor: Actor;
  /**
   * `false` on a surface the user has not joined yet — every tab would bounce
   * straight back through `requireTutor`, and offering a way out that is not
   * one is worse than offering none.
   */
  nav?: boolean;
  children: ReactNode;
}) {
  const items = nav ? NAV[surface] : [];
  const home = surface === "tutor" ? "/tutor" : "/courses";

  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-1 px-4 sm:gap-2">
          <Link
            href={home}
            className="shrink-0 rounded-lg text-sm font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:text-base"
          >
            Roll Tutor
          </Link>

          {/*
            A surface label, not a status badge — it says which side of the app
            you are looking at. Nothing in this product ranks a person visibly.
          */}
          {surface === "tutor" ? (
            <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent">
              Tutor
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
            <span className="hidden max-w-[16rem] truncate text-sm text-muted lg:block">
              {actor.email}
            </span>
            <SurfaceSwitch surface={surface} isTutor={actor.tutorProfileId !== null} />
            <SignOutButton />
          </div>
        </div>
      </header>

      {/* pb-28 clears the fixed tab bar; from md up, and with no tabs, it is gone. */}
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
