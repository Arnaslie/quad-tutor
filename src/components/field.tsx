import type { ComponentProps, ReactNode } from "react";

/**
 * Label, control, hint, error. The caller owns the `id` and passes the same one
 * to the control — `useId` would force this into a client component, and a
 * wrapper that drags every form on the site across the server boundary is not
 * worth the convenience.
 */
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

/**
 * Every control shares this, so a select and an input sitting in one form are
 * one system rather than two near-misses. Restyle here, not in a screen.
 *
 * `text-base` is load-bearing on mobile: iOS zooms the viewport on focus for
 * anything under 16px, and a form that jumps when you tap it feels broken.
 */
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

/**
 * `appearance-none` drops the platform chevron, so it is drawn back on as a
 * background image — a real `<select>` keeps the native picker on a phone,
 * which is the one control students should not have to learn.
 *
 * The stroke is a fixed mid-grey rather than `currentColor`: a data URI cannot
 * inherit, and this one reads against both the light and dark surface.
 */
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

/**
 * For the short free-text notes only — a dispute note, a "what do you want to
 * cover" line. Pass `maxLength` to match whatever the server action accepts, so
 * the limit is visible at the keyboard rather than discovered on submit.
 */
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
