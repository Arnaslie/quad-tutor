/**
 * How a person is named on screen.
 *
 * `user.name` can be empty. Signup now collects a name and `validateUserInfo`
 * refuses to create a user without one, so no new account arrives empty — but
 * accounts created before that check still have `length(name) = 0`, and
 * `seed.ts` inserts `user` rows directly rather than through Better Auth, so a
 * fixture that omits a name would never meet the boundary. A screen cannot
 * assume a name exists.
 *
 * Rendering `""` is not a cosmetic failure. A collapsed heading reads as a
 * missing field; mid-sentence it reads as a broken product — "Waiting on .",
 * "When  is free". On the deck it is a tutor card for nobody, on the one
 * screen the product converts on.
 *
 * This lives at the identity layer, and takes the role as an argument, because
 * the fallback noun is the only thing that differs between the two surfaces
 * and two copies of it drift. It imports nothing, so a client component can
 * use it: the bundler follows the import graph, not the symbol, and anything
 * reaching `db` would pull the postgres driver into the browser.
 *
 * The fallback is deliberately never the email address. Handing a stranger's
 * address to someone before either party has agreed to anything is not a call
 * a rendering helper gets to make.
 */

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
