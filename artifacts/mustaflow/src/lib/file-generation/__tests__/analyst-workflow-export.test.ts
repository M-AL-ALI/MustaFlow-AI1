import { describe, expect, it } from "vitest";
import type { DatasetAnalysisResult } from "@/types/dataset-analysis";
import {
  calculationSuggestionBullets,
  calculationSuggestionRows,
  chartSuggestionBullets,
  chartSuggestionRows,
  hasAnalystWorkflow,
  reportSuggestionBullets,
  reportSuggestionRows,
} from "../analyst-workflow-export";

const DATA: DatasetAnalysisResult = {
  type: "dataset-analysis",
  analysisType: "general",
  summary: "Dataset summary",
  usedFallback: false,
  sanitizedCellCount: 12,
  truncated: false,
  analystWorkflow: {
    chartSuggestions: [
      {
        title: "Revenue by Region",
        chartType: "bar",
        xColumn: "region",
        yColumn: "revenue",
        groupByColumn: "quarter",
        reason: "Compare revenue across regions.",
      },
    ],
    calculationSuggestions: [
      {
        label: "Total Revenue",
        expression: "SUM(revenue)",
        description: "Calculate total sales.",
        columns: ["revenue"],
      },
    ],
    reportSuggestions: [
      {
        format: "pdf",
        title: "Executive Summary",
        description: "Board-ready summary.",
      },
    ],
  },
};

describe("analyst workflow export helpers", () => {
  it("detects populated analyst workflows", () => {
    expect(hasAnalystWorkflow(DATA)).toBe(true);
    expect(hasAnalystWorkflow({ ...DATA, analystWorkflow: undefined })).toBe(false);
  });

  it("formats rows for analyst spreadsheets and document tables", () => {
    const workflow = DATA.analystWorkflow!;
    expect(chartSuggestionRows(workflow)).toEqual([
      [
        "Revenue by Region",
        "bar",
        "region",
        "revenue",
        "quarter",
        "Compare revenue across regions.",
      ],
    ]);
    expect(calculationSuggestionRows(workflow)).toEqual([
      ["Total Revenue", "SUM(revenue)", "Calculate total sales.", "revenue"],
    ]);
    expect(reportSuggestionRows(workflow)).toEqual([
      ["PDF", "Executive Summary", "Board-ready summary."],
    ]);
  });

  it("formats compact bullets for analyst slide decks", () => {
    const workflow = DATA.analystWorkflow!;
    expect(chartSuggestionBullets(workflow)[0]).toContain(
      "Revenue by Region (bar) - X: region, Y: revenue, Group: quarter",
    );
    expect(calculationSuggestionBullets(workflow)).toEqual([
      "Total Revenue: SUM(revenue) - Calculate total sales.",
    ]);
    expect(reportSuggestionBullets(workflow)).toEqual([
      "PDF: Executive Summary - Board-ready summary.",
    ]);
  });
});
