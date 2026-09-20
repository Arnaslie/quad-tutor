"use client";

import { useRouter } from "next/navigation";
import { useRef, useTransition } from "react";

import { Field, Input } from "@/components/field";

/**
 * The type-ahead, and the only client component in step one.
 *
 * The query lives in the URL rather than in state: the results are rendered on
 * the server, so a student who taps a course, backs out and taps another gets
 * their search back instead of an empty box. It also means this screen works
 * with JavaScript off — the surrounding `<form method="get">` submits to the
 * same place the keystroke handler navigates to.
 *
 * `replace` rather than `push`, so eight keystrokes do not become eight entries
 * in the back stack.
 */
export function CourseSearch({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function search(value: string) {
    if (timer.current) clearTimeout(timer.current);

    // Long enough that a fast typist sends one query, short enough that the
    // list feels like it is keeping up. Intake is budgeted at 45 seconds.
    timer.current = setTimeout(() => {
      const trimmed = value.trim();
      const href = trimmed.length > 0 ? `/courses?q=${encodeURIComponent(trimmed)}` : "/courses";
      startTransition(() => router.replace(href, { scroll: false }));
    }, 180);
  }

  return (
    <form action="/courses" method="get" className="flex flex-col gap-1.5">
      <Field
        id="course-search"
        label="Course"
        hint={isPending ? "Searching…" : "Course code or name — “MATH 125” or “calc”."}
      >
        <Input
          id="course-search"
          name="q"
          type="search"
          autoComplete="off"
          enterKeyHint="search"
          autoFocus
          defaultValue={initialQuery}
          placeholder="MATH 125"
          onChange={(event) => search(event.target.value)}
        />
      </Field>
    </form>
  );
}
