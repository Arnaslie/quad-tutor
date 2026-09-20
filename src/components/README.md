# Shared UI

Everything here is a **server component** unless the file starts with `"use client"`.
Only `nav-link.tsx` and `sign-out-button.tsx` do. Keep it that way: reach for
`"use client"` at the leaf that actually needs interaction, not at the screen.

---

## The one hard rule

**No ratings, no scores, no badges, no reputation numbers — on either side.**

There is deliberately no `Rating`, `Stars`, `Score` or `Badge` component in here,
and one must not be added.

- **Tutor quality** is expressed **only as rank order** in the deck. The score
  exists, it is per `(tutor, course)`, and it is never rendered. Not as stars, not
  as "top rated", not as a percentage, not as a subtle ordering hint with a number
  attached.
- **Student reliability** is expressed **only as platform mechanics** — a deposit
  is required, fewer parallel asks are allowed — and never as a visible score or
  a badge. Always phrase a mechanic as recoverable, because it is.
- Positive-only badges do **not** solve this. The *absence* of a badge is itself a
  signal. See `docs/decisions.md` → "Rejected, and why".

The `Tutor` pill in the header is a **surface label** (which side of the app you
are on), not a status. That is the only pill-shaped thing in the system.

---

## Primitives

### `button.tsx`

```tsx
<Button variant="primary" size="md" {...buttonProps} />
<ButtonLink href="/courses" variant="secondary" {...linkProps} />
buttonClass(variant?, size?, className?) // for the rare custom element
```

| prop | type | default |
|---|---|---|
| `variant` | `"primary" \| "secondary" \| "ghost" \| "danger"` | `"primary"` |
| `size` | `"md" \| "lg"` | `"md"` |

Both sizes clear a 44px touch target. `ButtonLink` takes every `next/link` prop;
`Button` takes every `<button>` prop. Navigation is an anchor — never an
`onClick` that pushes a route.

### `card.tsx`

```tsx
<Card padded={true} className="">…</Card>
<CardLink href="/courses/abc" padded={true}>…</CardLink>   // whole card is the tap target
```

`padded={false}` when the card holds its own list rows and you want the dividers
to run edge to edge.

### `field.tsx`

```tsx
const id = useId();          // client components only
<Field id={id} label="University email" hint={…} error={…}>
  <Input id={id} type="email" invalid={Boolean(error)} />
</Field>

<Field id={courseId} label="Which course?">
  <Select id={courseId} name="courseId" required>{options}</Select>
</Field>

<Field id={noteId} label="Note" hint="Up to 500 characters.">
  <Textarea id={noteId} name="note" maxLength={500} />
</Field>
```

| component | props |
|---|---|
| `Field` | `id` (required), `label`, `hint?`, `error?`, `children` |
| `Input` | every `<input>` prop, plus `invalid?: boolean` |
| `Select` | every `<select>` prop, plus `invalid?: boolean` |
| `Textarea` | every `<textarea>` prop, plus `invalid?: boolean` |

`Field` does **not** generate the id — `useId` would drag every form across the
server boundary. Pass the same id to both. `error` replaces `hint` and renders
with `role="alert"`.

All three controls share one class builder, so they line up as one system
(verified: select and input both measure exactly 48px). Restyle in `field.tsx`,
never in a screen — a copied class string is the thing the next restyle misses.
`Select` is a real `<select>`, so a phone gets its native picker. Pass
`maxLength` on a `Textarea` to match whatever the server action accepts, so the
limit is visible at the keyboard rather than discovered on submit.

`text-base` on every control is load-bearing: iOS zooms the viewport on focus
for anything under 16px, and a form that jumps when you tap it feels broken.

### `page-header.tsx`

```tsx
<PageHeader eyebrow="MATH 125 · Prof. Reed" title="Tutors" description="…" action={<ButtonLink …/>} />
```

`eyebrow` is where course context goes. On this product that line *is* the value
proposition, so it has a permanent slot rather than being written freehand.

### `empty-state.tsx`

```tsx
<EmptyState icon="book" title="…" description="…" action={…} />
```

Empty is a normal state here, not a failure. Say which kind it is: "that is all of
them" reads honest, "that is all we found" reads broken.

### `icons.tsx`

```tsx
<Icon name="book" className="size-5" />
```

`IconName`: `book | send | calendar | inbox | clock | cap | user | check |
arrow-right`. No icon package. Need a tenth? Add a path to `PATHS` — do not inline
an `<svg>` in a screen.

---

## Display helpers

### `money.tsx`

```tsx
<Money minor={14000} />              // "$140.00"
formatMinor(14000)                    // same, as a string
```

Money is integer minor units everywhere. `formatMinor` lives with the pricing
arithmetic in `src/server/modules/billing/pricing.ts` and is re-exported here so
screens have one import. **Do not write a second currency formatter.** That module
is pure — no db, no clock — which is what makes it safe in a client component.

### `format.ts`

```tsx
formatDay(value, timeZone?)      // "Tue, Oct 14"
formatTime(value, timeZone?)     // "6:30 PM"
formatDayTime(value, timeZone?)  // "Tue, Oct 14 at 6:30 PM"
formatCountdown(until, now?)     // "in 9h" · "in 3 days" · "expired"
CAMPUS_TIME_ZONE                 // "America/Chicago"
```

Two kinds of value come out of the database and they are **not** interchangeable:

- `timestamp` columns arrive as `Date` — a real instant, rendered campus-local.
- `date` columns (`exam.occursOn`, `term.startsOn`) arrive as `"2026-10-14"` — a
  calendar day with no instant. `new Date("2026-10-14")` is UTC midnight, which in
  Central time is the *previous evening*, so naive formatting shows an exam a day
  early. `formatDay` detects the bare-day form and handles it.

`CAMPUS_TIME_ZONE` is hardcoded to the launch campus. `institution.timezone`
exists in the schema but `currentActor()` does not return it yet; when campus #2
lands, thread it through and pass it as the `timeZone` argument.

---

## Shell

### `app-shell.tsx`

```tsx
<AppShell surface="student" actor={actor}>{children}</AppShell>
```

Used by the two group layouts only. Sticky header, one `max-w-5xl` column, bottom
tab bar under `md` and inline header nav from `md` up. Both bars render the same
`NAV` array, so a route cannot appear in one and be missing from the other.

### `nav-items.ts`

`NAV.student` and `NAV.tutor` — `{ href, label, icon, exact? }`. **The route map is
fixed.** Renaming an entry renames a URL. Four tabs is the ceiling at 390px; a
fifth surface goes behind one of these, not beside them.

| surface | routes |
|---|---|
| student | `/courses`, `/courses/[offeringId]`, `/requests`, `/sessions`, `/sessions/[id]` |
| tutor | `/tutor`, `/tutor/courses`, `/tutor/availability`, `/tutor/sessions` |

`/tutor/start` is the `becomeTutor` entry point and is deliberately not a tab.

### `nav-link.tsx` · `sign-out-button.tsx` · `surface-switch.tsx`

Shell internals. You should not need to import these directly.

---

## Writing a screen

Mobile-first, for real: author at **390px**, ladder up with `sm:` / `md:` / `lg:`.
The mobile view is the base layer, not a breakpoint.

```tsx
export default async function Page() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader … />
      {/* content */}
    </div>
  );
}
```

The layout already supplies the page padding, the max width and the bottom-bar
clearance. A page renders its own vertical stack and nothing else.

Colour comes from tokens in `src/app/globals.css`, never a raw hex:
`bg-background` `bg-surface` `bg-surface-sunken` `text-foreground` `text-muted`
`border-border` `bg-accent` `text-accent` `bg-accent-soft` `text-danger`
`bg-danger-soft`. Every one has a dark-mode value already; using them is how a
screen gets dark mode for free.

Gating: the group layouts call `requireActor()`, so a page below them always has a
signed-in user. Tutor **feature** pages must still call `requireTutor()` themselves
— the tutor layout deliberately does not, because `/tutor/start` lives inside it.
