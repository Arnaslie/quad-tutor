"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Icon } from "./icons";
import type { NavItem } from "./nav-items";

export function NavLink({
  item,
  style,
}: {
  item: NavItem;
  style: "tab" | "inline";
}) {
  const pathname = usePathname();
  const active = item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);

  const shared =
    "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background";

  if (style === "tab") {
    return (
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={`${shared} flex flex-1 flex-col items-center gap-1 rounded-lg py-2 text-xs font-medium ${
          active ? "text-accent" : "text-muted"
        }`}
      >
        <Icon name={item.icon} className="size-6" />
        {item.label}
      </Link>
    );
  }

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`${shared} flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${
        active
          ? "bg-accent-soft text-accent"
          : "text-muted hover:bg-surface-sunken hover:text-foreground"
      }`}
    >
      <Icon name={item.icon} className="size-[18px]" />
      {item.label}
    </Link>
  );
}
