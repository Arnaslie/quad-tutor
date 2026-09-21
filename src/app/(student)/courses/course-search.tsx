"use client";

import { useRouter } from "next/navigation";
import { useRef, useTransition } from "react";

import { Field, Input } from "@/components/field";

export function CourseSearch({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function search(value: string) {
    if (timer.current) clearTimeout(timer.current);

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
