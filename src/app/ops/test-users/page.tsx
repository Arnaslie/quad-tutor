import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { testPersonasOn } from "@/server/db/personas/lock";
import { requireOperator } from "@/server/modules/identity/actor";

import { ResetForm } from "./reset-form";

export const metadata: Metadata = { title: "Test users" };

export const maxDuration = 60;

export default async function TestUsersPage() {
  await requireOperator();
  if (!testPersonasOn()) notFound();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Test users"
        description="Deletes every test user on your campus and builds each one again in its test state. Real accounts are left alone. It takes up to a minute."
      />
      <ResetForm />
    </div>
  );
}
