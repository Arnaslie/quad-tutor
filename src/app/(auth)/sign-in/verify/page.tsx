import type { Metadata } from "next";

import { Button, ButtonLink } from "@/components/button";

export const metadata: Metadata = { title: "Sign in" };

const FORWARDED = [
  "token",
  "callbackURL",
  "newUserCallbackURL",
  "errorCallbackURL",
] as const;

/**
 * Mail scanners (Outlook Safe Links) fetch every link in a message, and a GET
 * to Better Auth's verify endpoint spends the single-use token before the
 * student taps it. Scanners load pages but do not submit forms, so the email
 * links here and only the button reaches the endpoint.
 */
export default async function VerifyPage(props: PageProps<"/sign-in/verify">) {
  const params = await props.searchParams;
  const hidden = FORWARDED.flatMap((name) => {
    const value = params[name];
    return typeof value === "string" ? [{ name, value }] : [];
  });

  if (!hidden.some((field) => field.name === "token")) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          That link is incomplete
        </h1>
        <ButtonLink href="/sign-in" size="lg">
          Send yourself a new one
        </ButtonLink>
      </div>
    );
  }

  return (
    <form
      action="/api/auth/magic-link/verify"
      method="get"
      className="flex flex-col gap-6"
    >
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Quad Tutor</h1>
        <p className="text-base text-muted">Tap below to finish signing in.</p>
      </div>

      {hidden.map((field) => (
        <input
          key={field.name}
          type="hidden"
          name={field.name}
          value={field.value}
        />
      ))}

      <Button type="submit" size="lg">
        Continue to Quad Tutor
      </Button>
    </form>
  );
}
