import { describe, expect, it } from "vitest";
import type { DatasetAnalysisResult } from "@/types/dataset-analysis";
import {
  buildAnalystChartSeries,
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
  paretoFindings: [
    { label: "West", value: 120, cumPct: 60 },
    { label: "East", value: 80, cumPct: 100 },
  ],
  actionPlan: [
    { action: "Fix pricing", priority: "high" },
    { action: "Improve onboarding", priority: "medium" },
    { action: "Monitor churn", priority: "medium" },
  ],
  healthScore: {
    score: 72,
    category: "Needs Attention",
    explanation: "Several risks need follow-up.",
  },
  enhancedRisks: [
    {
      risk: "Revenue concentration",
      riskScore: 88,
      riskLevel: "High",
      probability: "High",
      impact: "High",
      mitigation: "Diversify customer mix.",
    },
    {
      risk: "Delayed reporting",
      riskScore: 52,
      riskLevel: "Medium",
      probability: "Medium",
      impact: "Medium",
      mitigation: "Automate reporting.",
    },
  ],
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

  it("builds deterministic generated chart series from analysis data", () => {
    const series = buildAnalystChartSeries(DATA);
    expect(series.map((s) => s.title)).toEqual([
      "Pareto Contribution",
      "Risk Score by Issue",
      "Action Plan by Priority",
      "Overall Health Score",
    ]);
    expect(series[0]).toMatchObject({
      labels: ["West", "East"],
      values: [120, 80],
    });
    expect(series[2]).toMatchObject({
      labels: ["High", "Medium"],
      values: [1, 2],
    });
    expect(series[3]).toMatchObject({
      labels: ["Needs Attention"],
      values: [72],
      valueSuffix: "/100",
    });
  });
});
