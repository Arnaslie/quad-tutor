"use client";

import { useFormStatus } from "react-dom";

import { Button } from "@/components/button";

export function OnboardingButton({ label }: { label: string }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full sm:w-auto">
      {pending ? "Opening Stripe…" : label}
    </Button>
  );
}
