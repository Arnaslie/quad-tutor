"use client";

import { useActionState } from "react";

import { Button } from "@/components/button";
import { Card } from "@/components/card";
import type { ResetResult } from "@/server/db/personas/ops";

import { resetTestUsersAction } from "./actions";

export function ResetForm() {
  const [result, reset, pending] = useActionState<ResetResult | null>(resetTestUsersAction, null);

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

      {result?.status === "done" ? (
        <section className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            Reset {result.personas.length} test users. Sign in with any address below. Every link goes to the same inbox.
          </p>
          <ul className="flex flex-col gap-2">
            {result.personas.map((persona) => (
              <li key={persona.key}>
                <Card>
                  <p className="break-all font-mono text-sm">{persona.email}</p>
                  <p className="mt-1 text-sm text-muted">
                    {persona.role === "tutor" ? "Tutor" : "Student"} · {persona.state}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
