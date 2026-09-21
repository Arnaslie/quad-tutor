import type { IconName } from "./icons";

export type NavItem = {
  href: string;
  label: string;
  icon: IconName;

  exact?: boolean;
};

export type Surface = "student" | "tutor";

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
