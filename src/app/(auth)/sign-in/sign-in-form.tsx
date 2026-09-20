"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/button";
import { Field, Input } from "@/components/field";
import { authClient } from "@/lib/auth-client";

type State =
  | { status: "idle" | "sending" }
  | { status: "sent"; email: string }
  | { status: "error"; message: string };

/**
 * Remembering the name locally is what keeps this to one screen. Better Auth
 * uses `name` only when it creates the user, so a returning student's answer is
 * discarded server-side — but they would still have to type it. Prefilling from
 * the last successful send means they do not, and the intake stays under its
 * budget on the second visit as well as the first.
 */
const NAME_KEY = "tutor-finder:name";

export function SignInForm() {
  const nameId = useId();
  const emailId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });

  // The name field is uncontrolled so this can write straight to the DOM.
  // Reading storage during render would hydrate a mismatch against the empty
  // field the server sent, and restoring it through state would make an effect
  // trigger a second render for something React never needs to track.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(NAME_KEY);
      const field = nameRef.current;
      if (saved && field && !field.value) field.value = saved;
    } catch {
      // Private browsing throws on access. A blank field is a fine outcome.
    }
  }, []);

  if (state.status === "sent") {
    return <LinkSent email={state.email} onRestart={() => setState({ status: "idle" })} />;
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setState({ status: "sending" });

        const trimmedName = (nameRef.current?.value ?? "").trim();
        const trimmedEmail = email.trim();

        const { error } = await authClient.signIn.magicLink({
          // Better Auth applies this only when it creates the user, so sending
          // it on every request cannot overwrite an existing student's name.
          name: trimmedName,
          email: trimmedEmail,
          callbackURL: "/courses",
          errorCallbackURL: "/sign-in",
        });

        if (error) {
          // The server refuses addresses outside a known campus, at send time
          // rather than at click time. Show what it said — "check your email"
          // over a rejected address is a dead end the student cannot debug.
          setState({
            status: "error",
            message: error.message ?? "Could not send the sign-in link. Try again.",
          });
          return;
        }

        try {
          window.localStorage.setItem(NAME_KEY, trimmedName);
        } catch {
          // Not worth failing a successful sign-in over.
        }

        setState({ status: "sent", email: trimmedEmail });
      }}
    >
      <Field
        id={nameId}
        label="Your name"
        hint="First name and last initial is plenty. Tutors see this when you ask them for help."
      >
        <Input
          ref={nameRef}
          id={nameId}
          type="text"
          name="name"
          required
          autoFocus
          maxLength={80}
          autoComplete="name"
          placeholder="Maya C."
        />
      </Field>

      <Field
        id={emailId}
        label="University email"
        hint="Tutor Finder is live at the University of Alabama. Your .edu address is the verification."
        error={state.status === "error" ? state.message : undefined}
      >
        <Input
          id={emailId}
          type="email"
          name="email"
          required
          autoComplete="email"
          inputMode="email"
          placeholder="you@crimson.ua.edu"
          value={email}
          invalid={state.status === "error"}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>

      <Button type="submit" size="lg" disabled={state.status === "sending"}>
        {state.status === "sending" ? "Sending link…" : "Email me a sign-in link"}
      </Button>

      <p className="text-center text-sm text-muted">
        No password. The link signs you in.
      </p>
    </form>
  );
}

function LinkSent({ email, onRestart }: { email: string; onRestart: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-5">
        <h2 className="text-base font-medium">Check your email</h2>
        <p className="text-sm text-muted">
          A sign-in link is on its way to{" "}
          <span className="font-medium text-foreground">{email}</span>. It opens
          this app straight on your courses.
        </p>
      </div>

      {process.env.NODE_ENV === "production" ? null : (
        <div className="flex flex-col gap-2 rounded-2xl border border-dashed border-border bg-surface-sunken p-5">
          <h3 className="text-sm font-medium">Developing locally?</h3>
          <p className="text-sm text-muted">
            No email provider is wired up yet. The link was printed to the
            terminal running{" "}
            <code className="rounded bg-background px-1 py-0.5 font-mono text-[0.85em]">npm run dev</code>. Look
            for the two lines beginning{" "}
            <code className="rounded bg-background px-1 py-0.5 font-mono text-[0.85em]">[magic-link]</code> and
            open the URL on the second one. If you have lost the terminal, the
            same lines are in{" "}
            <code className="rounded bg-background px-1 py-0.5 font-mono text-[0.85em]">.next/dev/logs/next-development.log</code>.
          </p>
        </div>
      )}

      <Button variant="secondary" onClick={onRestart}>
        Use a different email
      </Button>
    </div>
  );
}
