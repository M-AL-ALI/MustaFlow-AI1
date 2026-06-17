/**
 * Professional document type detection and section guidance for Ora file generation.
 *
 * When the user asks Ora to create a professional document (executive summary,
 * audit report, KPI report, SOP, checklist, etc.) the generate-file route
 * detects the type from the user's message and injects type-specific section
 * requirements into the document system prompt. This drives polished,
 * ready-to-use deliverables instead of generic "Section 1 / Section 2" output.
 *
 * Security: only the detected doc-type label (a fixed string from our enum)
 * is injected into the system prompt — never user-supplied content.
 * Document cell values stay in the untrusted user-turn block.
 */

export type ProfessionalDocType =
  | "executive-summary"
  | "audit-report"
  | "kpi-report"
  | "sop"
  | "checklist"
  | "business-plan"
  | "meeting-summary"
  | "action-plan"
  | "root-cause-report"
  | "training-document"
  | "accounting-summary"
  | "process-improvement"
  | "dataset-report";

const DOC_TYPE_PATTERNS: Array<{ pattern: RegExp; type: ProfessionalDocType }> = [
  {
    pattern: /\b(root[\s-]?cause|rca\b|5[\s-]?why|five[\s-]?why|fishbone|ishikawa)\b/i,
    type: "root-cause-report",
  },
  {
    pattern: /\b(standard\s+operating\s+proc(?:edure)?|sop\b|work\s+instruction)\b/i,
    type: "sop",
  },
  {
    pattern:
      /\b(kpi\s+(?:report|dashboard|analysis|review)|performance\s+(?:report|dashboard|review)|scorecard|metrics\s+report)\b/i,
    type: "kpi-report",
  },
  {
    pattern: /\b(audit\s+report|compliance\s+audit|internal\s+audit|audit\s+findings)\b/i,
    type: "audit-report",
  },
  {
    pattern: /\b(meeting\s+(?:minutes|summary|notes|recap)|minutes\s+of\s+(?:the\s+)?meeting)\b/i,
    type: "meeting-summary",
  },
  {
    pattern: /\b(action\s+plan|action\s+items|corrective\s+action|action\s+register)\b/i,
    type: "action-plan",
  },
  {
    pattern: /\b(business\s+plan|go[\s-]to[\s-]market|gtm\s+plan|business\s+case)\b/i,
    type: "business-plan",
  },
  {
    pattern:
      /\b(training\s+(?:document|doc|guide|manual|plan|material|module)|onboarding\s+guide|user\s+guide)\b/i,
    type: "training-document",
  },
  {
    pattern:
      /\b(accounting\s+summary|financial\s+summary|profit[\s-]and[\s-]loss|p\s*[&+]\s*l\b|income\s+statement|balance\s+sheet)\b/i,
    type: "accounting-summary",
  },
  {
    pattern:
      /\b(process[\s-]?improvement|continuous[\s-]?improvement|lean\s+(?:report|analysis)|six[\s-]?sigma|kaizen|value[\s-]stream)\b/i,
    type: "process-improvement",
  },
  {
    pattern: /\b(checklist|check[\s-]list)\b/i,
    type: "checklist",
  },
  {
    pattern: /\b(executive\s+summary|exec\s+summary|executive\s+brief|exec\s+brief)\b/i,
    type: "executive-summary",
  },
  {
    pattern:
      /\b(dataset\s+report|data\s+(?:analysis\s+)?report|csv\s+report|spreadsheet\s+report|analysis\s+report)\b/i,
    type: "dataset-report",
  },
];

/**
 * Detect the professional document type from the user's message.
 * Returns null for generic documents that don't match a known type.
 */
export function detectProfessionalDocType(message: string): ProfessionalDocType | null {
  for (const { pattern, type } of DOC_TYPE_PATTERNS) {
    if (pattern.test(message)) return type;
  }
  return null;
}

/**
 * Type-specific section guidance injected into the document system prompt.
 * Tells the model exactly which sections to include and when to use the
 * optional "table" field for structured data (action items, KPIs, etc.).
 */
export function buildProfessionalDocSectionGuidance(
  docType: ProfessionalDocType,
  hasSourceData: boolean,
): string {
  const srcNote = hasSourceData
    ? "Base every section on the attached source data. Do not invent facts not present in the source."
    : "Generate realistic, substantive, professional content appropriate to the document type.";

  const guides: Record<ProfessionalDocType, string> = {
    "executive-summary": [
      `Document type: EXECUTIVE SUMMARY. ${srcNote}`,
      `Required sections in order:`,
      `1. Purpose and Background — context and scope in 2-3 sentences.`,
      `2. Key Findings — the most important facts or outcomes. Use a table when data supports comparison: headers ["Metric", "Value", "Status"].`,
      `3. Strategic Context — relevance to wider business goals.`,
      `4. Recommendations — numbered, prioritized, action-oriented.`,
      `5. Next Steps — immediate actions with owner and timeline when known.`,
    ].join("\n"),

    "audit-report": [
      `Document type: AUDIT REPORT. ${srcNote}`,
      `Required sections in order:`,
      `1. Audit Scope and Objectives — what was audited, timeframe, and goals.`,
      `2. Methodology — how the audit was conducted, sampling methods, tools used.`,
      `3. Findings — for each finding include a table: headers ["Finding", "Risk Level", "Impact", "Evidence"].`,
      `4. Gaps and Non-Conformances — list of gaps with severity level.`,
      `5. Recommendations — include a table: headers ["Recommendation", "Priority", "Owner", "Target Date"].`,
      `6. Management Response — space for response or comments (use "Pending" if unknown).`,
      `7. Conclusion — overall audit opinion and key risk rating.`,
    ].join("\n"),

    "kpi-report": [
      `Document type: KPI REPORT. ${srcNote}`,
      `Required sections in order:`,
      `1. Executive Summary — 2-3 sentences on overall performance.`,
      `2. KPI Dashboard — MUST include a table: headers ["KPI", "Current Value", "Target", "Gap", "Trend", "Status"]. Include every key metric.`,
      `3. Performance Trends — what is improving, declining, or flat and why.`,
      `4. Gap Analysis — which KPIs miss target and by how much.`,
      `5. Risks and Blockers — factors preventing target achievement.`,
      `6. Recommendations — prioritized, specific, measurable.`,
      `7. Action Plan — include a table: headers ["Action", "Owner", "Timeline", "Priority"].`,
    ].join("\n"),

    sop: [
      `Document type: STANDARD OPERATING PROCEDURE (SOP). ${srcNote}`,
      `Required sections in order:`,
      `1. Purpose and Scope — what this procedure covers and why it exists.`,
      `2. Definitions and Terms — glossary of key terms used.`,
      `3. Roles and Responsibilities — include a table: headers ["Role", "Responsibility"].`,
      `4. Procedure Steps — numbered list in execution order. Use "content" for prose steps and "bullets" for sub-steps. Be precise and unambiguous.`,
      `5. Exceptions and Escalations — what to do when standard steps cannot be followed.`,
      `6. Compliance and Safety Notes — regulatory or safety requirements.`,
      `7. Related Documents — references to related SOPs, templates, or forms.`,
      `8. Revision History — include a table: headers ["Version", "Date", "Author", "Changes"].`,
    ].join("\n"),

    checklist: [
      `Document type: CHECKLIST. ${srcNote}`,
      `Required sections in order:`,
      `1. Scope and Objective — what this checklist is for.`,
      `2. Pre-Requisites — what must be in place before starting.`,
      `3. Checklist Items — group items by category. Each category is a section; each item is a bullet written as an actionable verification. Do not add checkbox characters.`,
      `4. Notes and Instructions — special instructions or clarifications.`,
      `5. Sign-Off — final completion confirmation section.`,
    ].join("\n"),

    "business-plan": [
      `Document type: BUSINESS PLAN. ${srcNote}`,
      `Required sections in order:`,
      `1. Executive Summary — one-page overview of the entire plan.`,
      `2. Market Opportunity — market size, target segment, customer pain points.`,
      `3. Value Proposition — what makes this business or product uniquely valuable.`,
      `4. Business Model — how the business makes money: revenue streams, pricing.`,
      `5. Go-To-Market Strategy — channels, customer acquisition, marketing plan.`,
      `6. Financial Projections — include a table when data supports it: headers ["Year", "Revenue", "Costs", "Net Income"]; otherwise describe expected financials.`,
      `7. Team and Resources — key roles, team structure, resource requirements.`,
      `8. Risks and Mitigation — top risks with mitigation strategies.`,
      `9. Next Steps — immediate action items with timeline.`,
    ].join("\n"),

    "meeting-summary": [
      `Document type: MEETING SUMMARY. ${srcNote}`,
      `Required sections in order:`,
      `1. Meeting Information — include a table: headers ["Field", "Value"] with rows for Date, Attendees, Facilitator, and Purpose.`,
      `2. Agenda Items Discussed — one section per agenda item with key discussion points.`,
      `3. Key Decisions Made — clear numbered list of decisions taken.`,
      `4. Action Items — MUST include a table: headers ["Action", "Owner", "Due Date", "Status"]. Status defaults to "Open".`,
      `5. Open Questions and Parking Lot — items deferred for later.`,
      `6. Next Meeting — scheduled date and proposed agenda items.`,
    ].join("\n"),

    "action-plan": [
      `Document type: ACTION PLAN. ${srcNote}`,
      `Required sections in order:`,
      `1. Objectives — what this action plan aims to achieve.`,
      `2. Action Items — MUST include a table: headers ["Action", "Owner", "Due Date", "Priority", "Status"]. Priority: High/Medium/Low. Status: Not Started/In Progress/Complete.`,
      `3. Dependencies — what must happen before or in parallel with these actions.`,
      `4. Success Metrics — how completion and success will be measured.`,
      `5. Review Cadence — how often this plan will be reviewed and by whom.`,
    ].join("\n"),

    "root-cause-report": [
      `Document type: ROOT CAUSE ANALYSIS REPORT. ${srcNote}`,
      `Required sections in order:`,
      `1. Problem Statement — clear, specific description of the problem, when it occurred, and its impact.`,
      `2. Immediate Impact — quantified or described business impact.`,
      `3. Timeline of Events — chronological sequence of events leading to the problem.`,
      `4. 5-Why Analysis — present the chain as numbered Why/Answer pairs in the "content" field.`,
      `5. Fishbone Analysis — categorize causes: People, Process, Technology, Environment. Use bullets per category.`,
      `6. Likely Root Causes — top 2-3 verified root causes based on the analysis.`,
      `7. Corrective Actions — include a table: headers ["Action", "Owner", "Due Date", "Status"].`,
      `8. Preventive Measures — systemic changes to prevent recurrence.`,
      `9. Verification Plan — how effectiveness of corrective actions will be validated.`,
    ].join("\n"),

    "training-document": [
      `Document type: TRAINING DOCUMENT. ${srcNote}`,
      `Required sections in order:`,
      `1. Learning Objectives — 3-5 specific, measurable outcomes as bullets.`,
      `2. Target Audience and Prerequisites — who this is for and prior knowledge needed.`,
      `3. Content Modules — one section per module. Each has "content" for explanation and "bullets" for key steps or concepts.`,
      `4. Key Concepts — include a table: headers ["Term", "Definition"].`,
      `5. Exercises and Assessments — practical exercises, quizzes, or knowledge checks.`,
      `6. Summary — brief recap of what was covered.`,
      `7. References and Resources — links, documents, or tools for further reading.`,
    ].join("\n"),

    "accounting-summary": [
      `Document type: ACCOUNTING SUMMARY. ${srcNote}`,
      `Required sections in order:`,
      `1. Period and Scope — reporting period, entity, currency, and basis of preparation.`,
      `2. Revenue Summary — include a table: headers ["Category", "Amount", "Prior Period", "Variance", "Variance %"].`,
      `3. Expense Breakdown — include a table: headers ["Category", "Amount", "% of Total", "vs. Budget"].`,
      `4. Profit and Loss Summary — net revenue, total expenses, gross profit, net income.`,
      `5. Key Variances — most significant deviations from budget or prior period with explanations.`,
      `6. Financial Health Indicators — ratios or qualitative indicators relevant to the data.`,
      `7. Recommendations — financial actions based on the analysis.`,
    ].join("\n"),

    "process-improvement": [
      `Document type: PROCESS IMPROVEMENT REPORT. ${srcNote}`,
      `Required sections in order:`,
      `1. Current State Analysis — describe the current process, key steps, and performance metrics.`,
      `2. Problem Statement — specific inefficiencies, waste, or quality gaps being addressed.`,
      `3. Root Cause — key causes identified through analysis.`,
      `4. Future State Vision — what the improved process looks like.`,
      `5. Improvement Recommendations — specific changes organized by priority.`,
      `6. Implementation Plan — include a table: headers ["Phase", "Action", "Owner", "Timeline", "Status"].`,
      `7. KPIs and Success Metrics — metrics that prove the improvement worked, with baselines and targets.`,
      `8. Risks and Mitigation — risks to implementation with mitigation strategies.`,
    ].join("\n"),

    "dataset-report": [
      `Document type: DATA ANALYSIS REPORT. ${srcNote}`,
      `Required sections in order:`,
      `1. Executive Summary — 2-4 sentences on the dataset and the most important finding.`,
      `2. Dataset Overview — include a table: headers ["Attribute", "Value"] with rows for Row Count, Column Count, Date Range (if present), Source.`,
      `3. Data Quality Assessment — missing values, outlier counts, duplicate rows. Include a table: headers ["Column or Issue", "Count", "% of Total", "Severity"]. Reference the server-computed statistics — do not invent counts.`,
      `4. KPI Summary — include a table: headers ["Metric", "Value", "Benchmark or Target", "Status"] for key numeric columns.`,
      `5. Key Findings — specific, quantified insights. Reference server-computed statistics for exact numbers.`,
      `6. Trend Analysis — time-based patterns or categorical trends visible in the data.`,
      `7. Top Categories — categories that dominate the dataset (from Pareto data when available).`,
      `8. Risks and Limitations — data quality issues, coverage gaps, or caveats on interpretation.`,
      `9. Recommendations — specific, actionable, tied to the findings.`,
      `10. Action Plan — include a table: headers ["Action", "Owner", "Timeline", "Priority"].`,
    ].join("\n"),
  };

  return guides[docType];
}
