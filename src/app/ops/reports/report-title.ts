import type { ReportItem } from "@/server/modules/messaging/reports";

export function reportTitle(report: Pick<ReportItem, "subject" | "studentName" | "tutorName">): string {
  return report.subject === "rating"
    ? `${report.studentName} rated ${report.tutorName}`
    : `${report.studentName} and ${report.tutorName}`;
}
