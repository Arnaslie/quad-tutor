import { formatMinor } from "@/server/modules/billing/pricing";

/**
 * The only way money reaches the screen.
 *
 * `formatMinor` lives with the pricing arithmetic in
 * `src/server/modules/billing/pricing.ts` and is re-exported here so screens
 * have one import. That module is pure — no database, no clock — which is what
 * makes it safe to pull into a client component. Keep it that way.
 */
export { formatMinor };

export function Money({
  minor,
  currency = "usd",
  className,
}: {
  minor: number;
  currency?: string;
  className?: string;
}) {
  return (
    <span className={className}>{formatMinor(minor, currency)}</span>
  );
}
