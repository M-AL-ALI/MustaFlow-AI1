export type ReportTemplateId =
  | "default"
  | "executive-summary"
  | "operations-review"
  | "manufacturing-review"
  | "kpi-review"
  | "root-cause-investigation"
  | "corrective-action"
  | "continuous-improvement"
  | "lean-six-sigma"
  | "project-status"
  | "strategic-planning";

export type ReportSectionId =
  | "executive-summary"
  | "management-summary"
  | "key-findings"
  | "kpi-scorecard"
  | "trend-analysis"
  | "pareto-analysis"
  | "root-cause"
  | "risks"
  | "opportunities"
  | "recommendations"
  | "action-plan"
  | "priority-matrix"
  | "improvement-roadmap"
  | "next-steps";

export interface ReportTemplate {
  id: ReportTemplateId;
  label: string;
  description: string;
  sections: ReportSectionId[];
}

export const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    id: "default",
    label: "Standard Report",
    description: "Complete report with all available sections.",
    sections: [
      "executive-summary",
      "management-summary",
      "key-findings",
      "kpi-scorecard",
      "trend-analysis",
      "pareto-analysis",
      "root-cause",
      "risks",
      "opportunities",
      "recommendations",
      "action-plan",
      "priority-matrix",
      "improvement-roadmap",
      "next-steps",
    ],
  },
  {
    id: "executive-summary",
    label: "Executive Summary",
    description: "Concise 1–2 page overview for senior leadership.",
    sections: [
      "executive-summary",
      "management-summary",
      "key-findings",
      "risks",
      "recommendations",
      "next-steps",
    ],
  },
  {
    id: "operations-review",
    label: "Operations Review",
    description: "Operational performance with KPIs, trends, and action plan.",
    sections: [
      "executive-summary",
      "management-summary",
      "kpi-scorecard",
      "key-findings",
      "trend-analysis",
      "root-cause",
      "risks",
      "recommendations",
      "action-plan",
      "improvement-roadmap",
      "next-steps",
    ],
  },
  {
    id: "manufacturing-review",
    label: "Manufacturing Performance Review",
    description: "Shop-floor and production metrics with root cause analysis.",
    sections: [
      "executive-summary",
      "management-summary",
      "kpi-scorecard",
      "pareto-analysis",
      "root-cause",
      "key-findings",
      "risks",
      "recommendations",
      "action-plan",
      "improvement-roadmap",
      "next-steps",
    ],
  },
  {
    id: "kpi-review",
    label: "KPI Performance Review",
    description: "Focused KPI scorecard with status, trends, and gap analysis.",
    sections: [
      "executive-summary",
      "kpi-scorecard",
      "trend-analysis",
      "key-findings",
      "risks",
      "recommendations",
      "next-steps",
    ],
  },
  {
    id: "root-cause-investigation",
    label: "Root Cause Investigation",
    description: "Structured RCA with five whys, fishbone, and corrective actions.",
    sections: [
      "executive-summary",
      "management-summary",
      "key-findings",
      "root-cause",
      "pareto-analysis",
      "risks",
      "recommendations",
      "action-plan",
      "next-steps",
    ],
  },
  {
    id: "corrective-action",
    label: "Corrective Action Report",
    description: "Problem statement, root cause, corrective actions, and verification.",
    sections: [
      "executive-summary",
      "management-summary",
      "key-findings",
      "root-cause",
      "risks",
      "action-plan",
      "improvement-roadmap",
      "next-steps",
    ],
  },
  {
    id: "continuous-improvement",
    label: "Continuous Improvement Report",
    description: "CI initiative status with opportunities and improvement roadmap.",
    sections: [
      "executive-summary",
      "kpi-scorecard",
      "key-findings",
      "opportunities",
      "recommendations",
      "priority-matrix",
      "action-plan",
      "improvement-roadmap",
      "next-steps",
    ],
  },
  {
    id: "lean-six-sigma",
    label: "Lean Six Sigma Report",
    description: "DMAIC-aligned report with pareto analysis and statistical findings.",
    sections: [
      "executive-summary",
      "management-summary",
      "kpi-scorecard",
      "pareto-analysis",
      "root-cause",
      "key-findings",
      "recommendations",
      "action-plan",
      "priority-matrix",
      "improvement-roadmap",
      "next-steps",
    ],
  },
  {
    id: "project-status",
    label: "Project Status Report",
    description: "Project health, milestones, risks, and next steps.",
    sections: [
      "executive-summary",
      "management-summary",
      "key-findings",
      "risks",
      "action-plan",
      "improvement-roadmap",
      "next-steps",
    ],
  },
  {
    id: "strategic-planning",
    label: "Strategic Planning Report",
    description: "Strategic recommendations and long-range planning horizon.",
    sections: [
      "executive-summary",
      "management-summary",
      "key-findings",
      "opportunities",
      "risks",
      "recommendations",
      "priority-matrix",
      "improvement-roadmap",
      "next-steps",
    ],
  },
];

export function getTemplate(id: ReportTemplateId): ReportTemplate {
  return REPORT_TEMPLATES.find((t) => t.id === id) ?? REPORT_TEMPLATES[0];
}
