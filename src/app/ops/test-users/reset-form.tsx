"use client";

import { useActionState } from "react";

import { Button } from "@/components/button";
import { Card } from "@/components/card";
import type { PersonaSummary } from "@/server/db/personas/people";
import type { ResetResult, SignInLinkResult, TestUser } from "@/server/db/personas/ops";

import { resetTestUsersAction, sendSignInLinkAction } from "./actions";

function SendSignInLink({ email }: { email: string }) {
  const [result, send, pending] = useActionState<SignInLinkResult | null>(() => sendSignInLinkAction(email), null);

  return (
    <form action={send} className="mt-3 flex flex-col gap-2">
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Sending…" : result?.status === "sent" ? "Send another link" : "Send sign-in link"}
      </Button>
      {result?.status === "sent" ? (
        <p role="status" className="text-sm text-muted">
          Sent. The link works for 5 minutes.
        </p>
      ) : null}
      {result?.status === "refused" ? (
        <p role="alert" className="text-sm text-danger">
          {result.message}
        </p>
      ) : null}
    </form>
  );
}

export function ResetForm({ testUsers }: { testUsers: TestUser[] }) {
  const [result, reset, pending] = useActionState<ResetResult | null>(resetTestUsersAction, null);
  const personas: (TestUser & Partial<Pick<PersonaSummary, "state">>)[] =
    result?.status === "done" ? result.personas : testUsers;

  return (
    <div className="flex flex-col gap-6">
      <form action={reset} className="flex flex-col gap-3">
        <Button type="submit" variant="danger" disabled={pending}>
          {pending ? "Resetting…" : "Reset test users"}
        </Button>
        {result?.status === "refused" ? (
          <p role="alert" className="whitespace-pre-line break-words text-sm text-danger">
            {result.message}
          </p>
        ) : null}
      </form>

      {personas.length > 0 ? (
        <section className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            {result?.status === "done" ? `Reset ${personas.length} test users. ` : null}
            Send a sign-in link to the test user you want to be. Every link goes to the same inbox.
          </p>
          <ul className="flex flex-col gap-2">
            {personas.map((persona) => (
              <li key={persona.email}>
                <Card>
                  <p className="break-all font-mono text-sm">{persona.email}</p>
                  <p className="mt-1 text-sm text-muted">
                    {persona.role === "tutor" ? "Tutor" : "Student"}
                    {persona.state ? ` · ${persona.state}` : null}
                  </p>
                  <SendSignInLink email={persona.email} />
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
