"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { Field, Input } from "@/components/field";
import type { CollegeSummary } from "@/server/modules/catalog/courses";

function coursesHref(query: string, collegeId: string | undefined): string {
  const params = new URLSearchParams();
  const trimmed = query.trim();
  if (trimmed.length > 0) params.set("q", trimmed);
  if (collegeId) params.set("college", collegeId);
  const search = params.toString();
  return search ? `/courses?${search}` : "/courses";
}

export function CourseSearch({
  initialQuery,
  collegeId,
  colleges,
}: {
  initialQuery: string;
  collegeId: string | undefined;
  colleges: CollegeSummary[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState(initialQuery);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function search(value: string) {
    setQuery(value);
    if (timer.current) clearTimeout(timer.current);

    timer.current = setTimeout(() => {
      startTransition(() => router.replace(coursesHref(value, collegeId), { scroll: false }));
    }, 180);
  }

  const chips = [{ collegeId: undefined, name: "All" }, ...colleges];

  return (
    <div className="flex flex-col gap-3">
      <form action="/courses" method="get" className="flex flex-col gap-1.5">
        {collegeId && <input type="hidden" name="college" value={collegeId} />}
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

      {colleges.length > 0 && (
        <nav aria-label="Filter by college" className="flex flex-wrap gap-2">
          {chips.map((chip) => {
            const active = chip.collegeId === collegeId;
            return (
              <Link
                key={chip.collegeId ?? "all"}
                href={coursesHref(query, chip.collegeId)}
                replace
                scroll={false}
                aria-current={active ? "page" : undefined}
                className={
                  "inline-flex h-9 items-center rounded-full border px-3.5 text-sm font-medium " +
                  "transition-colors focus-visible:outline-none focus-visible:ring-2 " +
                  "focus-visible:ring-accent focus-visible:ring-offset-2 " +
                  "focus-visible:ring-offset-background " +
                  (active
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-border bg-surface text-muted hover:text-foreground")
                }
              >
                {chip.name}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}
