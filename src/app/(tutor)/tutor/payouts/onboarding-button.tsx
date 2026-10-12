"use client";

import { useFormStatus } from "react-dom";

import { Button, type ButtonVariant } from "@/components/button";

export function OnboardingButton({ label, variant }: { label: string; variant: ButtonVariant }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" variant={variant} size="lg" disabled={pending} className="w-full sm:w-auto">
      {pending ? "Opening Stripe…" : label}
    </Button>
  );
}
