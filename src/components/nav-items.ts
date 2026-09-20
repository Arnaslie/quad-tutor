import type { IconName } from "./icons";

export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  /** Prefix matching would light this up on every child route. */
  exact?: boolean;
};

export type Surface = "student" | "tutor";

/**
 * The route map. It is fixed — renaming an entry here renames a URL students
 * have bookmarked, so treat it as settled rather than as configuration.
 *
 * Four tabs is the ceiling on a 390px bar. If a fifth surface appears it goes
 * behind one of these, not beside them.
 */
export const NAV: Record<Surface, NavItem[]> = {
  student: [
    { href: "/courses", label: "Courses", icon: "book" },
    { href: "/requests", label: "Requests", icon: "send" },
    { href: "/sessions", label: "Sessions", icon: "calendar" },
  ],
  tutor: [
    { href: "/tutor", label: "Inbox", icon: "inbox", exact: true },
    { href: "/tutor/courses", label: "Courses", icon: "book" },
    { href: "/tutor/availability", label: "Hours", icon: "clock" },
    { href: "/tutor/sessions", label: "Sessions", icon: "calendar" },
  ],
};
