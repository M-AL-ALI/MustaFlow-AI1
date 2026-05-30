import type { KpiGap, ActionItem } from "@/types/dataset-analysis";
import type { ReportTemplateId } from "./report-templates";

export type KpiStatus = "On Target" | "Monitor" | "Immediate Action";

export interface ReportMetadata {
  title: string;
  reportType: string;
  templateId: ReportTemplateId;
  company: string;
  department: string;
  preparedFor: string;
  preparedBy: string;
  generatedDate: string;
}

export function deriveKpiStatus(kpi: KpiGap): KpiStatus {
  const gap = (kpi.gap ?? "").trim();
  if (!gap || gap === "\u2014" || gap === "0" || gap === "0%" || gap === "+0") {
    return "On Target";
  }
  if (gap.startsWith("-") || kpi.trend === "down") {
    return "Immediate Action";
  }
  return "Monitor";
}

export function deriveRiskLevel(riskCount: number): string {
  if (riskCount >= 3) return "High";
  if (riskCount >= 1) return "Medium";
  return "Low";
}

export interface ImprovementRoadmap {
  immediate: string[];
  thirtyDay: string[];
  sixtyDay: string[];
  ninetyPlus: string[];
}

export function buildRoadmap(
  actionPlan: ActionItem[] | undefined,
  nextSteps: string[] | undefined,
): ImprovementRoadmap {
  const plan = actionPlan ?? [];
  return {
    immediate: plan.filter((a) => a.priority === "high").map((a) => a.action),
    thirtyDay: plan.filter((a) => a.priority === "medium").map((a) => a.action),
    sixtyDay: plan.filter((a) => a.priority === "low").map((a) => a.action),
    ninetyPlus: (nextSteps ?? []).slice(0, 5),
  };
}
