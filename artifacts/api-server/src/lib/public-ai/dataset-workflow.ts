import type { DatasetSummary } from "./dataset-extract.js";
import type { ColumnProfile, ParetoSet } from "./dataset-stats.js";

export type DatasetChartType = "bar" | "line" | "scatter" | "pareto" | "histogram";
export type DatasetReportFormat = "xlsx" | "pdf" | "docx" | "pptx" | "csv";

export interface DatasetChartSuggestion {
  title: string;
  chartType: DatasetChartType;
  xColumn?: string;
  yColumn?: string;
  groupByColumn?: string;
  reason: string;
}

export interface DatasetCalculationSuggestion {
  label: string;
  expression: string;
  description: string;
  columns: string[];
}

export interface DatasetReportSuggestion {
  title: string;
  format: DatasetReportFormat;
  description: string;
}

export interface DatasetAnalystWorkflow {
  chartSuggestions: DatasetChartSuggestion[];
  calculationSuggestions: DatasetCalculationSuggestion[];
  reportSuggestions: DatasetReportSuggestion[];
}

const MAX_CHARTS = 5;
const MAX_CALCULATIONS = 6;

function header(summary: DatasetSummary, index: number | undefined): string | undefined {
  if (index === undefined || index < 0) return undefined;
  return summary.headers[index];
}

function bestNumericColumns(summary: DatasetSummary): ColumnProfile[] {
  return summary.columnProfiles
    .filter((p) => p.type === "numeric" && p.uniqueCount > 1)
    .sort((a, b) => {
      const aSpread = (a.max ?? 0) - (a.min ?? 0);
      const bSpread = (b.max ?? 0) - (b.min ?? 0);
      return bSpread - aSpread;
    });
}

function bestCategoryColumns(summary: DatasetSummary): ColumnProfile[] {
  return summary.columnProfiles
    .filter((p) => p.type === "string" && p.uniqueCount >= 2 && p.uniqueCount <= 50)
    .sort((a, b) => a.uniqueCount - b.uniqueCount);
}

function bestDateColumns(summary: DatasetSummary): ColumnProfile[] {
  return summary.columnProfiles.filter((p) => p.type === "date");
}

function paretoSuggestion(summary: DatasetSummary, set: ParetoSet): DatasetChartSuggestion | null {
  const category = header(summary, set.categoryColIndex);
  const value = header(summary, set.valueColIndex);
  if (!category || !value) return null;
  return {
    title: `Pareto of ${value} by ${category}`,
    chartType: "pareto",
    xColumn: category,
    yColumn: value,
    reason: "Shows the few categories responsible for the largest share of the metric.",
  };
}

export function buildDatasetAnalystWorkflow(summary: DatasetSummary): DatasetAnalystWorkflow {
  const numeric = bestNumericColumns(summary);
  const category = bestCategoryColumns(summary);
  const date = bestDateColumns(summary);

  const chartSuggestions: DatasetChartSuggestion[] = [];
  const calculations: DatasetCalculationSuggestion[] = [];

  for (const set of summary.paretoSets.slice(0, 2)) {
    const suggestion = paretoSuggestion(summary, set);
    if (suggestion) chartSuggestions.push(suggestion);
  }

  const primaryMetric = numeric[0];
  const primaryCategory = category[0];
  const primaryDate = date[0];

  if (primaryDate && primaryMetric && chartSuggestions.length < MAX_CHARTS) {
    chartSuggestions.push({
      title: `${header(summary, primaryMetric.index)} trend over ${header(summary, primaryDate.index)}`,
      chartType: "line",
      xColumn: header(summary, primaryDate.index),
      yColumn: header(summary, primaryMetric.index),
      reason: "Tracks whether the main metric is improving, declining, or flat over time.",
    });
  }

  if (primaryCategory && primaryMetric && chartSuggestions.length < MAX_CHARTS) {
    chartSuggestions.push({
      title: `${header(summary, primaryMetric.index)} by ${header(summary, primaryCategory.index)}`,
      chartType: "bar",
      xColumn: header(summary, primaryCategory.index),
      yColumn: header(summary, primaryMetric.index),
      reason: "Compares the main metric across the highest-signal category column.",
    });
  }

  if (numeric.length >= 2 && chartSuggestions.length < MAX_CHARTS) {
    chartSuggestions.push({
      title: `${header(summary, numeric[1]!.index)} vs ${header(summary, numeric[0]!.index)}`,
      chartType: "scatter",
      xColumn: header(summary, numeric[0]!.index),
      yColumn: header(summary, numeric[1]!.index),
      reason: "Checks whether two numeric metrics move together or show outliers.",
    });
  }

  if (primaryMetric && chartSuggestions.length < MAX_CHARTS) {
    chartSuggestions.push({
      title: `${header(summary, primaryMetric.index)} distribution`,
      chartType: "histogram",
      xColumn: header(summary, primaryMetric.index),
      reason: "Shows spread, skew, and possible outliers in the main metric.",
    });
  }

  for (const col of numeric.slice(0, 3)) {
    const name = header(summary, col.index);
    if (!name) continue;
    calculations.push({
      label: `Total ${name}`,
      expression: `SUM(${name})`,
      description: `Repeatable total across all ${summary.rowCount.toLocaleString()} analyzed rows.`,
      columns: [name],
    });
    if (calculations.length >= MAX_CALCULATIONS) break;
    calculations.push({
      label: `Average ${name}`,
      expression: `AVERAGE(${name})`,
      description: `Mean value using the server-computed numeric profile.`,
      columns: [name],
    });
    if (calculations.length >= MAX_CALCULATIONS) break;
  }

  if (primaryCategory && primaryMetric && calculations.length < MAX_CALCULATIONS) {
    const cat = header(summary, primaryCategory.index);
    const metric = header(summary, primaryMetric.index);
    if (cat && metric) {
      calculations.push({
        label: `${metric} by ${cat}`,
        expression: `GROUP BY ${cat}; SUM(${metric})`,
        description: "Repeatable grouped calculation for ranking categories by contribution.",
        columns: [cat, metric],
      });
    }
  }

  if (
    summary.duplicateRows &&
    summary.duplicateRows.duplicateRowCount > 0 &&
    calculations.length < MAX_CALCULATIONS
  ) {
    calculations.push({
      label: "Duplicate row rate",
      expression: "duplicate_rows / analyzed_rows",
      description: "Data-quality calculation to track repeated records before reporting.",
      columns: summary.headers.slice(0, 5),
    });
  }

  const reportSuggestions: DatasetReportSuggestion[] = [
    {
      title: "Executive analyst report",
      format: "pdf",
      description:
        "Download a shareable summary with findings, risks, recommendations, and next steps.",
    },
    {
      title: "Analysis workbook",
      format: "xlsx",
      description: "Export the analysis into spreadsheet form for repeated review and calculation.",
    },
    {
      title: "Action-plan CSV",
      format: "csv",
      description: "Export the recommended actions into a lightweight tracker.",
    },
    {
      title: "Leadership presentation",
      format: "pptx",
      description: "Turn the findings into a concise slide deck for review meetings.",
    },
  ];

  return {
    chartSuggestions: chartSuggestions.slice(0, MAX_CHARTS),
    calculationSuggestions: calculations.slice(0, MAX_CALCULATIONS),
    reportSuggestions,
  };
}
