import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { NAME_REQUIRED_MESSAGE } from "@/server/auth";
import { currentActor } from "@/server/modules/identity/actor";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Better Auth sends the browser back here with `?error=` when a link fails.
 *
 * This is an allowlist on purpose. The parameter is attacker-controllable — a
 * crafted link could otherwise put any sentence on our own sign-in page, which
 * is a phishing surface even though React escapes the text. Anything not
 * recognised falls back to the generic line below.
 */
const LINK_ERRORS: Record<string, string> = {
  INVALID_TOKEN: "That sign-in link is no longer valid. Send yourself a new one.",
  EXPIRED_TOKEN: "That sign-in link expired. Send yourself a new one.",
  // Only reachable by bypassing the form, but the generic message would send
  // someone into a resend loop that fails identically every time.
  [NAME_REQUIRED_MESSAGE]: NAME_REQUIRED_MESSAGE,
};

export default async function SignInPage(props: PageProps<"/sign-in">) {
  if (await currentActor()) redirect("/courses");

  const { error } = await props.searchParams;
  const code = typeof error === "string" ? error : null;
  const message = code
    ? (LINK_ERRORS[code] ?? "That sign-in link did not work. Send yourself a new one.")
    : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Quad Tutor</h1>
        <p className="text-base text-muted">
          Peer tutors who already took your course — under your professor.
        </p>
      </div>

      {message ? (
        <p
          role="alert"
          className="rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          {message}
        </p>
      ) : null}

      <SignInForm />
    </div>
  );
}
