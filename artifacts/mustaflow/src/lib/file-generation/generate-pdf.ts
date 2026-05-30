import type { OraMessage } from "@/hooks/use-ora-chat";
import type { DatasetAnalysisResult } from "@/types/dataset-analysis";
import type { ReportMetadata } from "./report-metadata";
import type { ReportTemplateId } from "./report-templates";
import { sanitizeForExport, sanitizeTitle } from "./sanitizer";
import { buildPrintHtml } from "@/components/ora/report-print-template";

export type PdfExportSource =
  | { kind: "dataset"; data: DatasetAnalysisResult; title?: string }
  | { kind: "message"; message: OraMessage; title?: string }
  | { kind: "conversation"; messages: OraMessage[]; title?: string };

function toTitleCase(s: string): string {
  return s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function triggerPrint(html: string): void {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("tabindex", "-1");
  iframe.style.cssText =
    "position:fixed;left:0;top:0;width:0;height:0;border:0;opacity:0;pointer-events:none";
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();

  // Cleanup: remove iframe once print dialog is dismissed.
  // onafterprint fires in Chrome, Edge, Firefox after the dialog closes (print or cancel).
  const fallbackTimer = setTimeout(() => iframe.remove(), 120_000);
  iframe.contentWindow!.onafterprint = () => {
    clearTimeout(fallbackTimer);
    setTimeout(() => iframe.remove(), 500);
  };

  // Brief delay for the iframe document to finish rendering before opening print dialog.
  setTimeout(() => {
    try {
      iframe.contentWindow!.focus();
      iframe.contentWindow!.print();
    } catch {
      clearTimeout(fallbackTimer);
      iframe.remove();
    }
  }, 400);
}

export function downloadPdf(
  source: PdfExportSource,
  _basename: string,
  meta?: ReportMetadata,
  templateId?: ReportTemplateId,
): void {
  if (source.kind === "dataset") {
    const data = sanitizeForExport(source.data);
    const reportTitle = meta?.title ?? sanitizeTitle(source.title ?? "Dataset Analysis Report");
    const reportType = meta?.reportType ?? toTitleCase(data.analysisType);
    triggerPrint(buildPrintHtml({ data, meta, templateId, reportTitle, reportType }));
  } else if (source.kind === "message") {
    const msg = sanitizeForExport(source.message);
    const reportTitle = meta?.title ?? sanitizeTitle(source.title ?? "Ora Response");
    const reportType = meta?.reportType ?? "Report";
    triggerPrint(
      buildPrintHtml({
        messages: [{ role: msg.role, content: msg.content }],
        meta,
        templateId,
        reportTitle,
        reportType,
      }),
    );
  } else {
    const msgs = sanitizeForExport(source.messages).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const reportTitle = meta?.title ?? sanitizeTitle(source.title ?? "Ora Conversation");
    const reportType = meta?.reportType ?? "Conversation Report";
    triggerPrint(buildPrintHtml({ messages: msgs, meta, templateId, reportTitle, reportType }));
  }
}
