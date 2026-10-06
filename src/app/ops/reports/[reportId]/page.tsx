import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { z } from "zod";

import { ButtonLink } from "@/components/button";
import { Card } from "@/components/card";
import { formatDayTime } from "@/components/format";
import { PageHeader } from "@/components/page-header";
import { MessageList } from "@/app/messages/message-list";
import { requireOperator, type OperatorActor } from "@/server/modules/identity/actor";
import {
  openReportedRating,
  openReportedThread,
  type ReportItem,
} from "@/server/modules/messaging/reports";
import { REPORT_OUTCOME_LABEL, REPORT_REASON_LABEL } from "@/server/modules/messaging/rules";
import { MessagingError } from "@/server/modules/messaging/threads";

import { ReviewForm } from "../review-form";

export const metadata: Metadata = { title: "Report" };

async function openReport(operator: OperatorActor, reportId: string) {
  try {
    return { report: await openReportedRating({ operator, reportId }), messages: null };
  } catch (error) {
    if (!(error instanceof MessagingError)) throw error;
  }
  try {
    return await openReportedThread({ operator, reportId });
  } catch (error) {
    if (error instanceof MessagingError) notFound();
    throw error;
  }
}

export default async function ReportPage(props: PageProps<"/ops/reports/[reportId]">) {
  const { reportId } = await props.params;
  if (!z.uuid().safeParse(reportId).success) notFound();
  const operator = await requireOperator();

  const { report, messages } = await openReport(operator, reportId);

  return (
    <ReportShell
      report={report}
      title={
        messages ? `${report.studentName} and ${report.tutorName}` : `${report.studentName} rated ${report.tutorName}`
      }
      logged={messages !== null}
    >
      {messages ? (
        <MessageList messages={messages} empty="No messages were sent in this conversation." />
      ) : (
        <RatingDetail report={report} />
      )}
    </ReportShell>
  );
}

function ReportShell({
  report,
  title,
  logged,
  children,
}: {
  report: ReportItem;
  title: string;
  logged: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={`${report.courseLabel} · ${REPORT_REASON_LABEL[report.reason]}`}
        title={title}
        description={`Reported by ${report.reporterName} on ${formatDayTime(report.createdAt)}.${
          logged ? " This view was logged." : ""
        }`}
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

      {children}

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

function RatingDetail({ report }: { report: ReportItem }) {
  return (
    <Card padded={false}>
      <dl className="divide-y divide-border text-sm">
        <div className="flex items-baseline justify-between gap-4 px-4 py-3 sm:px-5">
          <dt className="shrink-0 text-muted">Stars</dt>
          <dd className="font-medium">{report.ratingStars} of 5</dd>
        </div>
        <div className="flex flex-col gap-1 px-4 py-3 sm:px-5">
          <dt className="text-muted">What the student wrote</dt>
          <dd className="whitespace-pre-wrap">{report.ratingNote}</dd>
        </div>
        {report.ratingRemovedAt ? (
          <div className="flex items-baseline justify-between gap-4 px-4 py-3 sm:px-5">
            <dt className="shrink-0 text-muted">Removed</dt>
            <dd className="font-medium">{formatDayTime(report.ratingRemovedAt)}</dd>
          </div>
        ) : null}
      </dl>
    </Card>
  );
}
