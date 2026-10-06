export type IconName =
  | "book"
  | "send"
  | "calendar"
  | "inbox"
  | "clock"
  | "cap"
  | "user"
  | "check"
  | "arrow-right"
  | "chevron-down"
  | "pin"
  | "chat"
  | "flag"
  | "star";

const PATHS: Record<IconName, string> = {
  book: "M4 5.5A2.5 2.5 0 0 1 6.5 3H20v14H6.5A2.5 2.5 0 0 0 4 19.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5",
  send: "M21 3 10.5 13.5M21 3l-6.5 18-4-8-8-4z",
  calendar: "M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5zM8 3v4M16 3v4M4 11h16",
  inbox: "M4 13h4l1.5 3h5L16 13h4M4 13l2.6-8.2A1.5 1.5 0 0 1 8 3.7h8a1.5 1.5 0 0 1 1.4 1.1L20 13v5.5A2.5 2.5 0 0 1 17.5 21h-11A2.5 2.5 0 0 1 4 18.5z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2",
  cap: "m12 4 9.5 4.5L12 13 2.5 8.5zM6.5 10.8v4.9c0 1.6 2.5 3.1 5.5 3.1s5.5-1.5 5.5-3.1v-4.9",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5a7.5 7.5 0 0 1 15 0",
  check: "m5 12.5 4.5 4.5L19 7",
  "arrow-right": "M4 12h15m0 0-6-6m6 6-6 6",
  "chevron-down": "m6 9 6 6 6-6",
  chat: "M20 11.5a7.5 7.5 0 0 1-11 6.6L4 19.5l1.4-4.4A7.5 7.5 0 1 1 20 11.5z",
  flag: "M5 21V4.5M5 4.5h11l-2 4 2 4H5",
  star: "m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z",
  pin: "M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
};

export function Icon({
  name,
  className = "size-5",
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
