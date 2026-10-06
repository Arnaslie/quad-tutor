import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";

import { ButtonLink } from "@/components/button";
import { Card } from "@/components/card";
import { formatDayTime } from "@/components/format";
import { PageHeader } from "@/components/page-header";
import { MessageList } from "@/app/messages/message-list";
import { requireOperator } from "@/server/modules/identity/actor";
import { openReportedThread } from "@/server/modules/messaging/reports";
import { REPORT_OUTCOME_LABEL, REPORT_REASON_LABEL } from "@/server/modules/messaging/rules";
import { MessagingError } from "@/server/modules/messaging/threads";

import { ReviewForm } from "../review-form";

export const metadata: Metadata = { title: "Reported conversation" };

export default async function ReportedThreadPage(props: PageProps<"/ops/reports/[reportId]">) {
  const { reportId } = await props.params;
  if (!z.uuid().safeParse(reportId).success) notFound();
  const operator = await requireOperator();

  let opened: Awaited<ReturnType<typeof openReportedThread>>;
  try {
    opened = await openReportedThread({ operator, reportId });
  } catch (error) {
    if (error instanceof MessagingError) notFound();
    throw error;
  }
  const { report, messages } = opened;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={`${report.courseLabel} · ${REPORT_REASON_LABEL[report.reason]}`}
        title={`${report.studentName} and ${report.tutorName}`}
        description={`Reported by ${report.reporterName} on ${formatDayTime(report.createdAt)}. This view was logged.`}
        action={
          <ButtonLink href="/ops/reports" variant="secondary">
            All reports
          </ButtonLink>
        }
      />

      {report.note ? (
        <Card className="text-sm">
          <p className="text-muted">Their note</p>
          <p className="whitespace-pre-wrap pt-1">{report.note}</p>
        </Card>
      ) : null}

      <MessageList messages={messages} empty="No messages were sent in this conversation." />

      <Card>
        {report.outcome && report.reviewedAt ? (
          <p className="text-sm text-muted">
            Reviewed {formatDayTime(report.reviewedAt)}: {REPORT_OUTCOME_LABEL[report.outcome]}.
          </p>
        ) : (
          <ReviewForm reportId={report.id} subject={report.subject} />
        )}
      </Card>
    </div>
  );
}
