import type { DatasetAnalysisResult } from "@/types/dataset-analysis";

type Workflow = NonNullable<DatasetAnalysisResult["analystWorkflow"]>;

export interface AnalystChartSeries {
  title: string;
  labels: string[];
  values: number[];
  valueSuffix?: string;
}

function toNumber(value: string | number | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number.parseFloat(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function shorten(value: string, max = 28): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function hasAnalystWorkflow(data: DatasetAnalysisResult): boolean {
  const workflow = data.analystWorkflow;
  if (!workflow) return false;
  return (
    (workflow.chartSuggestions?.length ?? 0) > 0 ||
    (workflow.calculationSuggestions?.length ?? 0) > 0 ||
    (workflow.reportSuggestions?.length ?? 0) > 0
  );
}

export function chartSuggestionRows(workflow: Workflow): string[][] {
  return (workflow.chartSuggestions ?? []).map((chart) => [
    chart.title,
    chart.chartType,
    chart.xColumn ?? "",
    chart.yColumn ?? "",
    chart.groupByColumn ?? "",
    chart.reason,
  ]);
}

export function calculationSuggestionRows(workflow: Workflow): string[][] {
  return (workflow.calculationSuggestions ?? []).map((calc) => [
    calc.label,
    calc.expression,
    calc.description,
    (calc.columns ?? []).join(", "),
  ]);
}

export function reportSuggestionRows(workflow: Workflow): string[][] {
  return (workflow.reportSuggestions ?? []).map((report) => [
    report.format.toUpperCase(),
    report.title,
    report.description,
  ]);
}

export function chartSuggestionBullets(workflow: Workflow): string[] {
  return (workflow.chartSuggestions ?? []).map((chart) => {
    const columns = [
      chart.xColumn ? `X: ${chart.xColumn}` : "",
      chart.yColumn ? `Y: ${chart.yColumn}` : "",
      chart.groupByColumn ? `Group: ${chart.groupByColumn}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    return `${chart.title} (${chart.chartType})${columns ? ` - ${columns}` : ""}. ${chart.reason}`;
  });
}

export function calculationSuggestionBullets(workflow: Workflow): string[] {
  return (workflow.calculationSuggestions ?? []).map(
    (calc) => `${calc.label}: ${calc.expression} - ${calc.description}`,
  );
}

export function reportSuggestionBullets(workflow: Workflow): string[] {
  return (workflow.reportSuggestions ?? []).map(
    (report) => `${report.format.toUpperCase()}: ${report.title} - ${report.description}`,
  );
}

export function buildAnalystChartSeries(data: DatasetAnalysisResult): AnalystChartSeries[] {
  const series: AnalystChartSeries[] = [];

  const pareto = (data.paretoFindings ?? [])
    .map((finding) => ({ label: shorten(finding.label), value: toNumber(finding.value) }))
    .filter((row): row is { label: string; value: number } => row.value !== null)
    .slice(0, 8);
  if (pareto.length >= 2) {
    series.push({
      title: "Pareto Contribution",
      labels: pareto.map((row) => row.label),
      values: pareto.map((row) => row.value),
    });
  }

  const risks = (data.enhancedRisks ?? [])
    .map((risk) => ({ label: shorten(risk.risk), value: risk.riskScore }))
    .filter((row) => Number.isFinite(row.value))
    .slice(0, 8);
  if (risks.length >= 2) {
    series.push({
      title: "Risk Score by Issue",
      labels: risks.map((row) => row.label),
      values: risks.map((row) => row.value),
    });
  }

  const actionCounts = new Map<string, number>();
  for (const action of data.actionPlan ?? []) {
    actionCounts.set(action.priority, (actionCounts.get(action.priority) ?? 0) + 1);
  }
  const actionRows = ["high", "medium", "low"]
    .map((priority) => ({
      label: priority[0].toUpperCase() + priority.slice(1),
      value: actionCounts.get(priority) ?? 0,
    }))
    .filter((row) => row.value > 0);
  if (actionRows.length >= 2) {
    series.push({
      title: "Action Plan by Priority",
      labels: actionRows.map((row) => row.label),
      values: actionRows.map((row) => row.value),
    });
  }

  if (data.healthScore && Number.isFinite(data.healthScore.score)) {
    series.push({
      title: "Overall Health Score",
      labels: [data.healthScore.category],
      values: [data.healthScore.score],
      valueSuffix: "/100",
    });
  }

  return series.slice(0, 4);
}
