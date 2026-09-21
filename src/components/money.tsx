import { formatMinor } from "@/server/modules/billing/pricing";

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
