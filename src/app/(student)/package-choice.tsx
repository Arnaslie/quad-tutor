import type { ReactNode } from "react";

import { Money } from "@/components/money";
import type { PackageOption } from "@/server/modules/billing/pricing";

function title(option: PackageOption): string {
  if (option.kind === "top_up") return "One more session";
  if (option.kind === "through_final") return `${option.sessions} sessions — through the final`;
  return `${option.sessions} sessions`;
}

export function PackageChoice({
  option,
  currency,
  selected = true,
  onSelect,
  extra,
}: {
  option: PackageOption;
  currency?: string;
  selected?: boolean;
  onSelect?: () => void;
  extra?: ReactNode;
}) {
  const body = (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">{title(option)}</span>
        <Money minor={option.priceMinor} currency={currency} className="font-semibold" />
      </div>
      <p className="pt-1 text-sm text-muted">
        {option.sessions > 1 ? (
          <>
            <Money minor={option.perSessionMinor} currency={currency} /> a session
          </>
        ) : (
          "Full price"
        )}
        {option.savingsMinor > 0 ? (
          <>
            {" · saves "}
            <Money minor={option.savingsMinor} currency={currency} />
          </>
        ) : null}
        {extra}
      </p>
    </>
  );

  const shell = `rounded-2xl border p-4 text-left sm:p-5 ${
    selected ? "border-accent bg-accent-soft" : "border-border bg-surface"
  }`;

  if (!onSelect) return <div className={shell}>{body}</div>;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`${shell} transition-colors ${selected ? "" : "hover:bg-surface-sunken"}`}
    >
      {body}
    </button>
  );
}
