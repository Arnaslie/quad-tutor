"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Icon } from "./icons";
import { SignOutButton } from "./sign-out-button";

export function ProfileMenu({ name, email }: { name: string; email: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-label="Account"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-9 items-center gap-0.5 rounded-lg px-1.5 text-muted transition-colors hover:bg-surface-sunken hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-expanded:bg-surface-sunken aria-expanded:text-foreground"
      >
        <Icon name="user" className="size-[18px]" />
        <Icon
          name="chevron-down"
          className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      <div
        id={panelId}
        hidden={!open}
        className="absolute right-0 top-full z-30 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface p-1.5 shadow-lg"
      >
        <div className="px-3 py-2">
          {name && name !== email ? (
            <p className="truncate text-sm font-medium text-foreground">{name}</p>
          ) : null}
          <p className="truncate text-sm text-muted">{email}</p>
        </div>
        <div className="mt-1 border-t border-border pt-1.5">
          <SignOutButton />
        </div>
      </div>
    </div>
  );
}
