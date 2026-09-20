"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { authClient } from "@/lib/auth-client";
import { Button } from "./button";

/**
 * `refresh()` after the redirect matters: every server component in the shell
 * read the session, and without it the client cache would keep rendering the
 * signed-in header behind the sign-in screen.
 */
export function SignOutButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="ghost"
      className="h-9 px-2 text-sm sm:px-3"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          await authClient.signOut();
          router.replace("/sign-in");
          router.refresh();
        });
      }}
    >
      {pending ? "Signing out…" : "Sign out"}
    </Button>
  );
}
