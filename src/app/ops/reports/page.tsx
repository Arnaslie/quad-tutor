import type { Metadata } from "next";

import { CardLink } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { formatDayTime } from "@/components/format";
import { PageHeader } from "@/components/page-header";
import { requireOperator } from "@/server/modules/identity/actor";
import { reportsForOperator } from "@/server/modules/messaging/reports";
import { REPORT_OUTCOME_LABEL, REPORT_REASON_LABEL } from "@/server/modules/messaging/rules";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage() {
  const operator = await requireOperator();
  const reports = await reportsForOperator(operator);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Reported conversations"
        description="Opening a conversation is logged against your name. Only reported ones can be opened."
      />

      {reports.length === 0 ? (
        <EmptyState icon="flag" title="Nothing reported" description="No one on your campuses has reported a conversation." />
      ) : (
        <ul className="flex flex-col gap-2">
          {reports.map((report) => (
            <li key={report.id}>
              <CardLink href={`/ops/reports/${report.id}`} prefetch={false} className="flex flex-col gap-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted">
                  {REPORT_REASON_LABEL[report.reason]} · {formatDayTime(report.createdAt)}
                </p>
                <p className="font-medium">
                  {report.studentName} and {report.tutorName} · {report.courseLabel}
                </p>
                <p className="text-sm text-muted">
                  Reported by {report.reporterName}
                  {report.outcome ? ` · Reviewed: ${REPORT_OUTCOME_LABEL[report.outcome]}` : " · Waiting for review"}
                </p>
              </CardLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
