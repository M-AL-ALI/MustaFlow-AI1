import type { DatasetAnalysisResult } from "@/types/dataset-analysis";

type Workflow = NonNullable<DatasetAnalysisResult["analystWorkflow"]>;

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
