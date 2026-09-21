import type { ReactNode } from "react";

import { Icon, type IconName } from "./icons";

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: IconName;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border px-6 py-12 text-center">
      {icon ? (
        <span className="flex size-11 items-center justify-center rounded-full bg-surface-sunken text-muted">
          <Icon name={icon} />
        </span>
      ) : null}
      <h2 className="text-base font-medium text-foreground">{title}</h2>
      {description ? (
        <p className="max-w-sm text-sm text-muted">{description}</p>
      ) : null}
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
