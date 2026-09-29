import type { Metadata } from "next";

import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { formatDayTime } from "@/components/format";
import { PageHeader } from "@/components/page-header";
import { requireOperator } from "@/server/modules/identity/actor";
import { PROOF_KIND_LABEL } from "@/server/modules/tutoring/proof-rules";
import {
  PROOF_RETENTION_DAYS,
  verificationQueue,
  type VerificationQueueItem,
} from "@/server/modules/tutoring/verification";

import { DecisionForm } from "./decision-form";

export const metadata: Metadata = { title: "Verifications" };

export default async function VerificationsPage() {
  const operator = await requireOperator();
  const queue = await verificationQueue(operator);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Course verifications"
        description={`Check the name, the course, the term and an A- or better. Files are deleted once you decide, or after ${PROOF_RETENTION_DAYS} days.`}
      />

      {queue.length === 0 ? (
        <EmptyState icon="check" title="Nothing waiting" description="Every claim with proof has a decision." />
      ) : (
        <ul className="flex flex-col gap-4">
          {queue.map((item) => (
            <li key={item.tutorCourseId}>
              <ClaimReview item={item} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ClaimReview({ item }: { item: VerificationQueueItem }) {
  const label = item.courseCode ?? item.courseTitle;

  return (
    <Card className="grid gap-5 md:grid-cols-[1fr_18rem]">
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          {item.proofKind ? PROOF_KIND_LABEL[item.proofKind] : "Proof"} · sent{" "}
          {formatDayTime(item.submittedAt)}
        </p>
        <h2 className="text-lg font-semibold tracking-tight">
          {item.tutorName} · {label}
        </h2>
        <p className="text-sm text-muted">{item.tutorEmail}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Course</dt>
          <dd>
            {label} — {item.courseTitle}
          </dd>
          <dt className="text-muted">Term</dt>
          <dd>{item.takenTermName}</dd>
          <dt className="text-muted">Professor</dt>
          <dd>{item.professorName ?? "Not given"}</dd>
          <dt className="text-muted">Grade claimed</dt>
          <dd>{item.gradeEarned}</dd>
        </dl>
        <ul className="flex flex-wrap gap-2 pt-1">
          {item.files.map((file, index) => (
            <li key={file.id}>
              <a
                href={`/ops/verifications/files/${file.id}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm font-medium hover:bg-surface-sunken"
              >
                {item.files.length === 1 ? "Open file" : `File ${index + 1}`}
              </a>
            </li>
          ))}
        </ul>
      </div>
      <DecisionForm tutorCourseId={item.tutorCourseId} />
    </Card>
  );
}
