import type { ComponentProps, ReactNode } from "react";

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint && !error ? <p className="text-sm text-muted">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function controlClass(invalid: boolean, shape: string, className = "") {
  return `w-full rounded-xl border bg-surface text-base text-foreground placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
    invalid ? "border-danger" : "border-border"
  } ${shape} ${className}`.trim();
}

export function Input({
  invalid = false,
  className,
  ...props
}: ComponentProps<"input"> & { invalid?: boolean }) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={controlClass(invalid, "h-12 px-3.5", className)}
      {...props}
    />
  );
}

const CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238b8b95' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")";

export function Select({
  invalid = false,
  className,
  ...props
}: ComponentProps<"select"> & { invalid?: boolean }) {
  return (
    <select
      aria-invalid={invalid || undefined}
      className={controlClass(invalid, "h-12 appearance-none pl-3.5 pr-10", className)}
      style={{
        backgroundImage: CHEVRON,
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 0.75rem center",
        backgroundSize: "1.15rem",
      }}
      {...props}
    />
  );
}

export function Textarea({
  invalid = false,
  className,
  ...props
}: ComponentProps<"textarea"> & { invalid?: boolean }) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={controlClass(invalid, "min-h-24 px-3.5 py-3 leading-relaxed", className)}
      {...props}
    />
  );
}
