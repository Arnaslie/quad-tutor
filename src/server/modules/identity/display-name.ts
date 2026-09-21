export type DisplayRole = "tutor" | "student";

const FALLBACK: Record<DisplayRole, string> = {
  tutor: "A tutor",
  student: "A student",
};

export function displayName(
  name: string | null | undefined,
  role: DisplayRole,
): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : FALLBACK[role];
}
