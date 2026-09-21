import type { Metadata } from "next";
import { z } from "zod";

import { ButtonLink } from "@/components/button";
import { Card, CardLink } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { Icon } from "@/components/icons";
import { PageHeader } from "@/components/page-header";
import {
  courseById,
  offeringsForCourse,
  searchSeededCourses,
} from "@/server/modules/catalog/courses";
import { requireActor } from "@/server/modules/identity/actor";

import { CourseSearch } from "./course-search";

export const metadata: Metadata = { title: "Courses" };

const courseParam = z.uuid();

export default async function CoursesPage(props: PageProps<"/courses">) {
  const actor = await requireActor();
  const searchParams = await props.searchParams;

  const raw = searchParams.course;
  const selected = courseParam.safeParse(Array.isArray(raw) ? raw[0] : raw);

  if (selected.success) {
    return <OfferingStep courseId={selected.data} institutionId={actor.institutionId} />;
  }

  const queryRaw = searchParams.q;
  const query = (Array.isArray(queryRaw) ? queryRaw[0] : queryRaw) ?? "";

  return <CourseStep query={query} institutionId={actor.institutionId} />;
}

async function CourseStep({
  query,
  institutionId,
}: {
  query: string;
  institutionId: string;
}) {
  const courses = await searchSeededCourses({ institutionId, query });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="What are you stuck in?"
        description="Pick the course, then the section and professor. Under 45 seconds, start to finish."
      />

      <CourseSearch initialQuery={query} />

      {courses.length === 0 ? (
        <EmptyState
          icon="book"
          title={query.trim() ? `Nothing matching “${query.trim()}”` : "No courses yet"}
          description={
            query.trim()
              ? "We cover a short list of the courses people actually get stuck in, not the whole catalog. Try the code, or a word from the title."
              : "The catalog has not been seeded for this campus yet."
          }
        />
      ) : (
        <section className="flex flex-col gap-2" aria-label="Courses">
          {courses.map((course) => (
            <CardLink
              key={course.courseId}
              href={`/courses?course=${course.courseId}`}
              className="flex items-center gap-3"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">{course.code}</p>
                <p className="truncate text-sm text-muted">{course.title}</p>
              </div>
              <Icon name="arrow-right" className="size-5 shrink-0 text-muted" />
            </CardLink>
          ))}
        </section>
      )}
    </div>
  );
}

async function OfferingStep({
  courseId,
  institutionId,
}: {
  courseId: string;
  institutionId: string;
}) {
  const [course, offerings] = await Promise.all([
    courseById({ courseId, institutionId }),
    offeringsForCourse({ courseId, institutionId }),
  ]);

  if (!course) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="That course is not on our list" />
        <EmptyState
          icon="book"
          title="Start again"
          description="The link may be from another campus, or from a term that has ended."
          action={<ButtonLink href="/courses">Pick a course</ButtonLink>}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={course.code}
        title="Which section?"
        description="Who teaches it is the whole point — a tutor who had your professor knows the real exams and the curve."
        action={
          <ButtonLink href="/courses" variant="secondary">
            Change course
          </ButtonLink>
        }
      />

      {offerings.length === 0 ? (
        <EmptyState
          icon="book"
          title="No sections running this term"
          description={`${course.title} is on our list, but nobody is teaching it right now.`}
          action={<ButtonLink href="/courses">Pick another course</ButtonLink>}
        />
      ) : (
        <section className="flex flex-col gap-2" aria-label="Sections">
          {offerings.map((offering) => (
            <CardLink
              key={offering.offeringId}
              href={`/courses/${offering.offeringId}`}
              className="flex items-center gap-3"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {offering.professorName ?? "Instructor not listed"}
                </p>
                <p className="truncate text-sm text-muted">
                  Section {offering.section ?? "—"} · {offering.termName}
                </p>
              </div>
              <Icon name="arrow-right" className="size-5 shrink-0 text-muted" />
            </CardLink>
          ))}
        </section>
      )}

      <Card className="text-sm text-muted">
        Not sure which section you are in? It is on your schedule in myBama, next
        to the course code.
      </Card>
    </div>
  );
}
