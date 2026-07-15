import { describe, expect, it } from "vitest";
import { buildDatasetAnalystWorkflow } from "../dataset-workflow";
import type { DatasetSummary } from "../dataset-extract";

const summary: DatasetSummary = {
  rowCount: 120,
  colCount: 4,
  headers: ["date", "region", "revenue", "orders"],
  sampleRows: [],
  columnProfiles: [
    {
      index: 0,
      type: "date",
      nullCount: 0,
      uniqueCount: 12,
      minDate: "2026-01-01",
      maxDate: "2026-12-01",
    },
    {
      index: 1,
      type: "string",
      nullCount: 0,
      uniqueCount: 4,
      topCategories: [{ value: "West", count: 40 }],
    },
    {
      index: 2,
      type: "numeric",
      nullCount: 0,
      uniqueCount: 100,
      min: 10,
      max: 5000,
      mean: 1200,
      sum: 144000,
      stddev: 300,
    },
    {
      index: 3,
      type: "numeric",
      nullCount: 0,
      uniqueCount: 80,
      min: 1,
      max: 300,
      mean: 42,
      sum: 5040,
      stddev: 12,
    },
  ],
  paretoSets: [
    {
      categoryColIndex: 1,
      valueColIndex: 2,
      entries: [
        { label: "West", value: 65000, cumPct: 45.1 },
        { label: "East", value: 42000, cumPct: 74.3 },
      ],
    },
  ],
  duplicateRows: {
    duplicateRowCount: 3,
    duplicateGroupCount: 1,
    sampleDuplicates: [{ count: 4, preview: "2026-01-01 | West | 100 | 2" }],
  },
  sanitizedCellCount: 0,
  hiddenSheetsSkipped: 0,
  truncated: false,
};

describe("buildDatasetAnalystWorkflow", () => {
  it("suggests charts, repeatable calculations, and downloadable reports", () => {
    const workflow = buildDatasetAnalystWorkflow(summary);

    expect(workflow.chartSuggestions.map((c) => c.chartType)).toEqual(
      expect.arrayContaining(["pareto", "line", "bar", "scatter"]),
    );
    expect(workflow.chartSuggestions[0]).toMatchObject({
      title: "Pareto of revenue by region",
      xColumn: "region",
      yColumn: "revenue",
    });

    expect(workflow.calculationSuggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Total revenue", expression: "SUM(revenue)" }),
        expect.objectContaining({ label: "Average revenue", expression: "AVERAGE(revenue)" }),
        expect.objectContaining({ label: "revenue by region" }),
      ]),
    );

    expect(workflow.reportSuggestions.map((r) => r.format)).toEqual(["pdf", "xlsx", "csv", "pptx"]);
  });
});
