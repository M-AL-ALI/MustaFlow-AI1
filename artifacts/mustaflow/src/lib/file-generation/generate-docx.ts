import type { OraMessage } from "@/hooks/use-ora-chat";
import type { DatasetAnalysisResult } from "@/types/dataset-analysis";
import type { ReportMetadata } from "./report-metadata";
import type { ReportTemplateId, ReportSectionId } from "./report-templates";
import { deriveKpiStatus, deriveRiskLevel, buildRoadmap } from "./report-metadata";
import { getTemplate } from "./report-templates";
import { sanitizeForExport, sanitizeTitle, sanitizeSummary, truncateArray } from "./sanitizer";
import { LIMITS } from "./size-limits";
import { triggerDownload, sanitizeFilenameLocal } from "./utils";

export type DocxExportSource =
  | { kind: "dataset"; data: DatasetAnalysisResult; title?: string }
  | { kind: "message"; message: OraMessage; title?: string }
  | { kind: "conversation"; messages: OraMessage[]; title?: string };

function dateStr(): string {
  return new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export async function downloadDocx(
  source: DocxExportSource,
  basename: string,
  meta?: ReportMetadata,
  templateId?: ReportTemplateId,
): Promise<void> {
  const {
    Document,
    Paragraph,
    TextRun,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    WidthType,
    AlignmentType,
    ShadingType,
    BorderStyle,
    Packer,
  } = await import("docx");

  type Block = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;

  // ── Template section gating ────────────────────────────────────────────────
  const visibleSections = templateId
    ? new Set<ReportSectionId>(getTemplate(templateId).sections)
    : null;
  const show = (s: ReportSectionId) => !visibleSections || visibleSections.has(s);

  // ── Block helpers ──────────────────────────────────────────────────────────
  const h1 = (text: string): InstanceType<typeof Paragraph> =>
    new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 200 } });

  const h2 = (text: string): InstanceType<typeof Paragraph> =>
    new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 120 } });

  const h3 = (text: string): InstanceType<typeof Paragraph> =>
    new Paragraph({ text, heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 80 } });

  const body = (text: string): InstanceType<typeof Paragraph> =>
    new Paragraph({ children: [new TextRun(text)], spacing: { after: 100 } });

  const metaLine = (text: string): InstanceType<typeof Paragraph> =>
    new Paragraph({ children: [new TextRun({ text, italics: true })], spacing: { after: 80 } });

  const bullet = (text: string): InstanceType<typeof Paragraph> =>
    new Paragraph({
      children: [new TextRun(`\u2022  ${text}`)],
      indent: { left: 360 },
      spacing: { after: 80 },
    });

  const numbered = (text: string, i: number): InstanceType<typeof Paragraph> =>
    new Paragraph({
      children: [new TextRun(`${i + 1}. ${text}`)],
      indent: { left: 360 },
      spacing: { after: 80 },
    });

  const spacer = (): InstanceType<typeof Paragraph> => new Paragraph({ text: "" });

  const centeredBold = (text: string, size: number): InstanceType<typeof Paragraph> =>
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 160, after: 160 },
      children: [new TextRun({ text, bold: true, size })],
    });

  const centeredText = (
    text: string,
    size: number,
    italics = false,
  ): InstanceType<typeof Paragraph> =>
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 80, after: 80 },
      children: [new TextRun({ text, size, italics })],
    });

  const hrLine = (): InstanceType<typeof Paragraph> =>
    new Paragraph({
      border: {
        bottom: { color: "1E3A5F", space: 4, style: BorderStyle.SINGLE, size: 6 },
      },
      spacing: { before: 240, after: 240 },
      children: [],
    });

  const metaRow = (label: string, value: string): InstanceType<typeof Paragraph> =>
    new Paragraph({
      spacing: { after: 80 },
      children: [
        new TextRun({ text: `${label}: `, bold: true, size: 22 }),
        new TextRun({ text: value || "\u2014", size: 22 }),
      ],
    });

  // ── Table helpers ──────────────────────────────────────────────────────────
  const plainHeaderCell = (text: string): InstanceType<typeof TableCell> =>
    new TableCell({
      children: [
        new Paragraph({ children: [new TextRun({ text, bold: true })], spacing: { after: 60 } }),
      ],
    });

  const shadedHeaderCell = (text: string): InstanceType<typeof TableCell> =>
    new TableCell({
      shading: { fill: "1E3A5F", type: ShadingType.CLEAR, color: "auto" },
      children: [
        new Paragraph({
          children: [new TextRun({ text, bold: true, color: "FFFFFF" })],
          spacing: { after: 60 },
        }),
      ],
    });

  const dataCell = (text: string): InstanceType<typeof TableCell> =>
    new TableCell({ children: [body(text)] });

  const makeTable = (
    headers: string[],
    rows: string[][],
    widths: number[],
    shaded = false,
  ): InstanceType<typeof Table> =>
    new Table({
      width: { size: 9000, type: WidthType.DXA },
      columnWidths: widths,
      rows: [
        new TableRow({
          children: headers.map(shaded ? shadedHeaderCell : plainHeaderCell),
          tableHeader: true,
        }),
        ...rows.map((row) => new TableRow({ children: row.map(dataCell) })),
      ],
    });

  // ── Cover page (when metadata is provided) ─────────────────────────────────
  const coverChildren: Block[] = [];
  if (meta) {
    for (let i = 0; i < 7; i++) coverChildren.push(spacer());
    coverChildren.push(centeredBold(meta.title, 72));
    coverChildren.push(centeredText(meta.reportType, 40));
    coverChildren.push(hrLine());
    if (meta.company) coverChildren.push(metaRow("Company", meta.company));
    if (meta.department) coverChildren.push(metaRow("Department", meta.department));
    coverChildren.push(metaRow("Generated", meta.generatedDate));
    if (meta.preparedFor) coverChildren.push(metaRow("Prepared For", meta.preparedFor));
    if (meta.preparedBy) coverChildren.push(metaRow("Prepared By", meta.preparedBy));
    for (let i = 0; i < 8; i++) coverChildren.push(spacer());
    coverChildren.push(centeredText("Generated by Ora AI  \u00B7  MustaFlow AI", 20, true));
  }

  // ── Main content ───────────────────────────────────────────────────────────
  const children: Block[] = [];

  if (source.kind === "dataset") {
    const data = sanitizeForExport(source.data);
    const title = meta?.title ?? sanitizeTitle(source.title ?? "Dataset Analysis Report");

    children.push(h1(title));
    if (!meta) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: "Analysis Type: ", bold: true }),
            new TextRun(data.analysisType),
          ],
          spacing: { after: 60 },
        }),
      );
      children.push(metaLine(`Generated: ${dateStr()}  \u00B7  Generated by Ora AI`));
      children.push(spacer());
    }

    // Executive Summary
    if (show("executive-summary")) {
      children.push(h2("Executive Summary"));
      const summaryLines = sanitizeSummary(data.summary).split("\n");
      summaryLines.forEach((line) => {
        if (line.trim()) children.push(body(line));
        else children.push(spacer());
      });
      children.push(spacer());
    }

    // Management Summary
    if (show("management-summary") && data.summary) {
      const firstSentence = data.summary.split(/[.!?]/)[0]?.trim() ?? data.summary.slice(0, 180);
      const why =
        data.rootCauseAnalysis?.likelyCauses?.[0] ??
        data.keyFindings?.[0] ??
        "See Key Findings section.";
      const impact = data.risksAndLimitations?.[0] ?? "See Risks section.";
      const riskLevel = deriveRiskLevel(data.risksAndLimitations?.length ?? 0);
      const action =
        data.actionPlan?.find((a) => a.priority === "high")?.action ??
        data.recommendations?.[0] ??
        "See Recommendations section.";

      children.push(h2("Management Summary"));
      children.push(
        makeTable(
          ["Category", "Detail"],
          [
            ["What Happened", firstSentence + "."],
            ["Why It Happened", why],
            ["Operational Impact", impact],
            ["Risk Level", riskLevel],
            ["Recommended Action", action],
          ],
          [2500, 6500],
          true,
        ),
      );
      children.push(spacer());
    }

    // Key Findings
    if (show("key-findings") && data.keyFindings?.length) {
      children.push(h2("Key Findings"));
      truncateArray(data.keyFindings, LIMITS.maxFindings).forEach((f, i) => {
        children.push(numbered(f, i));
      });
      children.push(spacer());
    }

    // KPI Scorecard (enhanced — includes Status column)
    if (show("kpi-scorecard") && data.kpiGaps?.length) {
      children.push(h2("KPI Scorecard"));
      const rows = truncateArray(data.kpiGaps, LIMITS.maxKpiRows).map((k) => [
        k.metric,
        k.current,
        k.target ?? "",
        k.gap ?? "",
        deriveKpiStatus(k),
        k.trend ?? "",
      ]);
      children.push(
        makeTable(
          ["Metric", "Current", "Target", "Gap", "Status", "Trend"],
          rows,
          [2000, 1300, 1300, 1400, 1800, 1200],
          true,
        ),
      );
      children.push(spacer());
    }

    // Trend Analysis
    if (show("trend-analysis") && data.trendFindings?.length) {
      children.push(h2("Trend Analysis"));
      truncateArray(data.trendFindings, LIMITS.maxTrendRows).forEach((t) => {
        children.push(
          new Paragraph({
            children: [
              t.direction
                ? new TextRun({ text: `[${t.direction.toUpperCase()}]  `, bold: true })
                : new TextRun(""),
              new TextRun(t.description),
            ],
            spacing: { after: 80 },
          }),
        );
      });
      children.push(spacer());
    }

    // Pareto Analysis
    if (show("pareto-analysis") && data.paretoFindings?.length) {
      children.push(h2("Pareto Analysis"));
      const rows = truncateArray(data.paretoFindings, LIMITS.maxParetoRows).map((p) => [
        p.label,
        String(p.value),
        p.cumPct != null ? `${p.cumPct.toFixed(1)}%` : "",
      ]);
      children.push(
        makeTable(["Category", "Value", "Cumulative %"], rows, [4000, 2500, 2500], true),
      );
      children.push(spacer());
    }

    // Root Cause Analysis
    if (show("root-cause") && data.rootCauseAnalysis) {
      const rca = data.rootCauseAnalysis;
      children.push(h2("Root Cause Analysis"));
      if (rca.likelyCauses?.length) {
        children.push(h3("Likely Causes"));
        rca.likelyCauses.forEach((c) => children.push(bullet(c)));
        children.push(spacer());
      }
      if (rca.fiveWhys?.length) {
        children.push(h3("Five Whys"));
        rca.fiveWhys.forEach((why, i) => children.push(numbered(why, i)));
        children.push(spacer());
      }
      if (rca.fishbone) {
        children.push(h3("Fishbone — Cause Categories"));
        for (const [category, causes] of Object.entries(rca.fishbone)) {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: category, bold: true })],
              spacing: { after: 60 },
            }),
          );
          causes.forEach((c) => children.push(bullet(c)));
        }
        children.push(spacer());
      }
    }

    // Risks & Limitations
    if (show("risks") && data.risksAndLimitations?.length) {
      children.push(h2("Risks & Limitations"));
      data.risksAndLimitations.forEach((r) => children.push(bullet(r)));
      children.push(spacer());
    }

    // Opportunities
    if (show("opportunities") && data.recommendations?.length) {
      const opps = data.recommendations.slice(0, LIMITS.maxOpportunities);
      children.push(h2("Key Opportunities"));
      children.push(
        body(
          "Based on the analysis, the following opportunities have been identified to drive improvement and business value:",
        ),
      );
      children.push(spacer());
      opps.forEach((r, i) => children.push(numbered(r, i)));
      children.push(spacer());
    }

    // Recommendations
    if (show("recommendations") && data.recommendations?.length) {
      children.push(h2("Recommendations"));
      truncateArray(data.recommendations, LIMITS.maxRecommendations).forEach((r, i) => {
        children.push(numbered(r, i));
      });
      children.push(spacer());
    }

    // Action Plan
    if (show("action-plan") && data.actionPlan?.length) {
      children.push(h2("Action Plan"));
      const rows = truncateArray(data.actionPlan, LIMITS.maxActionPlanRows).map((a) => [
        a.action,
        a.priority,
        a.owner ?? "",
        a.timeline ?? "",
      ]);
      children.push(
        makeTable(
          ["Action", "Priority", "Owner", "Timeline"],
          rows,
          [3800, 1500, 2000, 1700],
          true,
        ),
      );
      children.push(spacer());
    }

    // Priority Matrix
    if (show("priority-matrix") && data.actionPlan?.length) {
      children.push(h2("Priority Action Matrix"));
      const high = data.actionPlan.filter((a) => a.priority === "high");
      const medium = data.actionPlan.filter((a) => a.priority === "medium");
      const low = data.actionPlan.filter((a) => a.priority === "low");

      if (high.length) {
        children.push(h3("High Priority \u2014 Immediate Action Required"));
        high.forEach((a) =>
          children.push(
            bullet(
              `${a.action}${a.owner ? `  (Owner: ${a.owner})` : ""}${a.timeline ? `  \u00B7  ${a.timeline}` : ""}`,
            ),
          ),
        );
        children.push(spacer());
      }
      if (medium.length) {
        children.push(h3("Medium Priority \u2014 Short-term Action"));
        medium.forEach((a) =>
          children.push(
            bullet(
              `${a.action}${a.owner ? `  (Owner: ${a.owner})` : ""}${a.timeline ? `  \u00B7  ${a.timeline}` : ""}`,
            ),
          ),
        );
        children.push(spacer());
      }
      if (low.length) {
        children.push(h3("Lower Priority \u2014 Monitor / Consider"));
        low.forEach((a) =>
          children.push(
            bullet(
              `${a.action}${a.owner ? `  (Owner: ${a.owner})` : ""}${a.timeline ? `  \u00B7  ${a.timeline}` : ""}`,
            ),
          ),
        );
        children.push(spacer());
      }
    }

    // Improvement Roadmap
    if (show("improvement-roadmap") && (data.actionPlan?.length || data.nextSteps?.length)) {
      children.push(h2("Improvement Roadmap"));
      const roadmap = buildRoadmap(data.actionPlan, data.nextSteps);
      const roadmapRows: string[][] = [];
      roadmap.immediate
        .slice(0, LIMITS.maxRoadmapItems)
        .forEach((a) => roadmapRows.push(["Immediate (0\u201330 Days)", a, "High"]));
      roadmap.thirtyDay
        .slice(0, LIMITS.maxRoadmapItems)
        .forEach((a) => roadmapRows.push(["Short-term (30\u201360 Days)", a, "Medium"]));
      roadmap.sixtyDay
        .slice(0, LIMITS.maxRoadmapItems)
        .forEach((a) => roadmapRows.push(["Medium-term (60\u201390 Days)", a, "Low"]));
      roadmap.ninetyPlus.forEach((a) => roadmapRows.push(["Strategic (90+ Days)", a, "Strategic"]));

      if (roadmapRows.length > 0) {
        children.push(
          makeTable(["Timeframe", "Action", "Priority"], roadmapRows, [2800, 5000, 1200], true),
        );
      }
      children.push(spacer());
    }

    // Next Steps
    if (show("next-steps") && data.nextSteps?.length) {
      children.push(h2("Next Steps"));
      data.nextSteps.forEach((s) => children.push(bullet(s)));
    }
  } else if (source.kind === "message") {
    const msg = sanitizeForExport(source.message);
    const title = meta?.title ?? sanitizeTitle(source.title ?? "Ora Response");
    const roleLabel = msg.role === "user" ? "User" : "Ora";

    children.push(h1(title));
    if (!meta) {
      children.push(metaLine(`Generated: ${dateStr()}  \u00B7  Generated by Ora AI`));
      children.push(spacer());
    }
    children.push(h2(roleLabel));
    msg.content.split("\n").forEach((line) => {
      if (line.trim()) children.push(body(line));
      else children.push(spacer());
    });
  } else {
    const messages = truncateArray(
      source.messages.map((m) => sanitizeForExport(m)),
      LIMITS.maxDocxSections,
    );
    const title = meta?.title ?? sanitizeTitle(source.title ?? "Ora Conversation");

    children.push(h1(title));
    if (!meta) {
      children.push(
        metaLine(
          `Generated: ${dateStr()}  \u00B7  ${messages.length} messages  \u00B7  Generated by Ora AI`,
        ),
      );
      children.push(spacer());
    }
    messages.forEach((msg, idx) => {
      const roleLabel = msg.role === "user" ? "You" : "Ora";
      children.push(h2(roleLabel));
      msg.content.split("\n").forEach((line) => {
        if (line.trim()) children.push(body(line));
        else children.push(spacer());
      });
      if (idx < messages.length - 1) children.push(spacer());
    });
  }

  const doc = new Document({
    sections: [
      ...(meta ? [{ properties: {}, children: coverChildren }] : []),
      { properties: {}, children: children },
    ],
  });

  const blob = await Packer.toBlob(doc);
  triggerDownload(blob, sanitizeFilenameLocal(basename) + ".docx");
}
