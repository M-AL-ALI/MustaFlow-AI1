import { describe, expect, it } from "vitest";
import { oraMessageSchema } from "@workspace/ora-contracts";

describe("Ora dataset result persistence contract", () => {
  it("keeps analyst workflow metadata through the shared message schema", () => {
    const parsed = oraMessageSchema.parse({
      role: "assistant",
      content: "Dataset analyzed.",
      datasetResult: {
        summary: "Revenue rose in the West region.",
        rowCount: 120,
        columnCount: 4,
        analysisType: "trend",
        keyFindings: ["West contributed the largest revenue share."],
        actionPlan: [{ action: "Review regional campaigns", priority: "high" }],
        analystWorkflow: {
          chartSuggestions: [
            {
              title: "Revenue by region",
              chartType: "bar",
              xColumn: "region",
              yColumn: "revenue",
              reason: "Compares revenue concentration by region.",
            },
          ],
          calculationSuggestions: [
            {
              label: "Total revenue",
              expression: "SUM(revenue)",
              description: "Repeatable total for the revenue column.",
              columns: ["revenue"],
            },
          ],
          reportSuggestions: [
            {
              title: "Executive analyst report",
              format: "pdf",
              description: "Shareable report.",
            },
          ],
        },
      },
    });

    expect(parsed.datasetResult?.analystWorkflow?.chartSuggestions?.[0]?.title).toBe(
      "Revenue by region",
    );
    expect(parsed.datasetResult?.actionPlan?.[0]?.action).toBe("Review regional campaigns");
  });
});
