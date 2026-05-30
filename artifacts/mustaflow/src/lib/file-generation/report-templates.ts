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
  | "next-steps"
  // Phase 7B-4B intelligence sections
  | "health-score"
  | "financial-impact"
  | "operational-impact"
  | "customer-impact"
  | "why-this-matters"
  | "enhanced-recommendations"
  | "strategic-roadmap"
  | "enhanced-risks";

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
    description: "Complete report with all available sections including AI intelligence.",
    sections: [
      "health-score",
      "executive-summary",
      "management-summary",
      "why-this-matters",
      "key-findings",
      "kpi-scorecard",
      "trend-analysis",
      "pareto-analysis",
      "root-cause",
      "risks",
      "enhanced-risks",
      "financial-impact",
      "operational-impact",
      "customer-impact",
      "opportunities",
      "recommendations",
      "enhanced-recommendations",
      "action-plan",
      "priority-matrix",
      "improvement-roadmap",
      "strategic-roadmap",
      "next-steps",
    ],
  },
  {
    id: "executive-summary",
    label: "Executive Summary",
    description: "Concise 1–2 page overview for senior leadership with AI health scoring.",
    sections: [
      "health-score",
      "executive-summary",
      "management-summary",
      "why-this-matters",
      "key-findings",
      "financial-impact",
      "risks",
      "enhanced-risks",
      "recommendations",
      "next-steps",
    ],
  },
  {
    id: "operations-review",
    label: "Operations Review",
    description: "Operational performance with KPIs, trends, and AI impact assessment.",
    sections: [
      "health-score",
      "executive-summary",
      "management-summary",
      "kpi-scorecard",
      "key-findings",
      "trend-analysis",
      "root-cause",
      "operational-impact",
      "financial-impact",
      "risks",
      "enhanced-risks",
      "recommendations",
      "enhanced-recommendations",
      "action-plan",
      "strategic-roadmap",
      "improvement-roadmap",
      "next-steps",
    ],
  },
  {
    id: "manufacturing-review",
    label: "Manufacturing Performance Review",
    description:
      "Shop-floor and production metrics with root cause analysis and operational impact.",
    sections: [
      "health-score",
      "executive-summary",
      "management-summary",
      "kpi-scorecard",
      "pareto-analysis",
      "root-cause",
      "key-findings",
      "operational-impact",
      "risks",
      "enhanced-risks",
      "recommendations",
      "enhanced-recommendations",
      "action-plan",
      "improvement-roadmap",
      "next-steps",
    ],
  },
  {
    id: "kpi-review",
    label: "KPI Performance Review",
    description: "Focused KPI scorecard with status, trends, gap analysis, and financial impact.",
    sections: [
      "health-score",
      "executive-summary",
      "kpi-scorecard",
      "trend-analysis",
      "key-findings",
      "financial-impact",
      "risks",
      "recommendations",
      "enhanced-recommendations",
      "next-steps",
    ],
  },
  {
    id: "root-cause-investigation",
    label: "Root Cause Investigation",
    description:
      "Structured RCA with five whys, fishbone, corrective actions, and enhanced risk scoring.",
    sections: [
      "executive-summary",
      "management-summary",
      "key-findings",
      "root-cause",
      "pareto-analysis",
      "risks",
      "enhanced-risks",
      "recommendations",
      "enhanced-recommendations",
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
      "enhanced-risks",
      "action-plan",
      "enhanced-recommendations",
      "improvement-roadmap",
      "next-steps",
    ],
  },
  {
    id: "continuous-improvement",
    label: "Continuous Improvement Report",
    description:
      "CI initiative status with opportunities, financial impact, and strategic roadmap.",
    sections: [
      "health-score",
      "executive-summary",
      "kpi-scorecard",
      "key-findings",
      "financial-impact",
      "opportunities",
      "recommendations",
      "enhanced-recommendations",
      "priority-matrix",
      "action-plan",
      "improvement-roadmap",
      "strategic-roadmap",
      "next-steps",
    ],
  },
  {
    id: "lean-six-sigma",
    label: "Lean Six Sigma Report",
    description:
      "DMAIC-aligned report with pareto analysis, operational impact, and strategic roadmap.",
    sections: [
      "health-score",
      "executive-summary",
      "management-summary",
      "kpi-scorecard",
      "pareto-analysis",
      "root-cause",
      "key-findings",
      "operational-impact",
      "recommendations",
      "enhanced-recommendations",
      "action-plan",
      "priority-matrix",
      "improvement-roadmap",
      "strategic-roadmap",
      "next-steps",
    ],
  },
  {
    id: "project-status",
    label: "Project Status Report",
    description: "Project health, milestones, risks, and next steps.",
    sections: [
      "health-score",
      "executive-summary",
      "management-summary",
      "why-this-matters",
      "key-findings",
      "risks",
      "enhanced-risks",
      "action-plan",
      "improvement-roadmap",
      "next-steps",
    ],
  },
  {
    id: "strategic-planning",
    label: "Strategic Planning Report",
    description: "Strategic recommendations, long-range planning, and executive intelligence.",
    sections: [
      "health-score",
      "executive-summary",
      "management-summary",
      "why-this-matters",
      "key-findings",
      "financial-impact",
      "operational-impact",
      "customer-impact",
      "opportunities",
      "risks",
      "enhanced-risks",
      "recommendations",
      "enhanced-recommendations",
      "priority-matrix",
      "improvement-roadmap",
      "strategic-roadmap",
      "next-steps",
    ],
  },
];

export function getTemplate(id: ReportTemplateId): ReportTemplate {
  return REPORT_TEMPLATES.find((t) => t.id === id) ?? REPORT_TEMPLATES[0];
}
