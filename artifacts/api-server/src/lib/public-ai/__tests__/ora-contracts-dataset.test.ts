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

  it("keeps Phase 9A file/data preview metadata through the shared message schema", () => {
    const parsed = oraMessageSchema.parse({
      role: "assistant",
      content: "Dataset analyzed.",
      datasetResult: {
        summary: "Revenue rose in the West region.",
        fileAgentPreview: {
          kind: "data_analysis",
          status: "planned",
          title: "Data analysis workflow",
          detectedInputs: ["120 rows", "4 columns"],
          plannedActions: ["Compare regional revenue"],
          calculations: ["Total revenue"],
          charts: ["Revenue by region"],
        },
      },
      fileAgentPreview: {
        kind: "data_analysis",
        status: "planned",
        title: "Data analysis workflow",
        detectedInputs: ["120 rows", "4 columns"],
        plannedActions: ["Compare regional revenue"],
        calculations: ["Total revenue"],
        charts: ["Revenue by region"],
      },
    });

    expect(parsed.datasetResult?.fileAgentPreview?.title).toBe("Data analysis workflow");
    expect(parsed.fileAgentPreview?.detectedInputs).toContain("120 rows");
    expect(parsed.fileAgentPreview?.charts).toContain("Revenue by region");
  });
});

describe("Ora file edit-quality persistence contract", () => {
  it("keeps editQuality through the shared message schema while stripping file bytes", () => {
    const parsed = oraMessageSchema.parse({
      role: "assistant",
      content: "I've updated your deck.",
      generatedFile: {
        fileName: "board-review.pptx",
        fileData: "QUJD",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        format: "pptx",
        assetId: 42,
        editQuality: {
          editMode: "original_edited",
          changes: ['Replaced: "Old Pricing" → "New Pricing"'],
          originalFileName: "board-review.pptx",
          outputFileName: "board-review.pptx",
          sourceFileType: "pptx",
          preservedLayout: true,
          canRedesign: true,
        },
      },
    });

    // Bytes are stripped on persistence; the quality card metadata is KEPT.
    expect(parsed.generatedFile).toBeDefined();
    expect((parsed.generatedFile as Record<string, unknown>).fileData).toBeUndefined();
    expect(parsed.generatedFile?.assetId).toBe(42);
    expect(parsed.generatedFile?.editQuality?.editMode).toBe("original_edited");
    expect(parsed.generatedFile?.editQuality?.changes?.[0]).toBe(
      'Replaced: "Old Pricing" → "New Pricing"',
    );
    expect(parsed.generatedFile?.editQuality?.preservedLayout).toBe(true);
  });

  it("keeps warnings for failed-safe outcomes and rejects unknown edit modes", () => {
    const parsed = oraMessageSchema.parse({
      role: "assistant",
      content: "Returned unchanged.",
      generatedFile: {
        fileName: "report.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        format: "docx",
        editQuality: {
          editMode: "failed_safe",
          changes: [],
          warning: "Couldn't locate the exact text to change.",
        },
      },
    });
    expect(parsed.generatedFile?.editQuality?.editMode).toBe("failed_safe");
    expect(parsed.generatedFile?.editQuality?.warning).toContain("Couldn't locate");

    expect(() =>
      oraMessageSchema.parse({
        role: "assistant",
        content: "Bad mode.",
        generatedFile: {
          fileName: "report.docx",
          mimeType: "application/msword",
          format: "docx",
          editQuality: { editMode: "made_up_mode" },
        },
      }),
    ).toThrow();
  });

  it("keeps Phase 9A generated-file preview metadata with persisted file cards", () => {
    const parsed = oraMessageSchema.parse({
      role: "assistant",
      content: "I've updated your deck.",
      generatedFile: {
        fileName: "board-review.pptx",
        fileData: "QUJD",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        format: "pptx",
        assetId: 42,
      },
      fileAgentPreview: {
        kind: "file_generation",
        status: "applied",
        title: "Created PowerPoint deck",
        plannedActions: ["Structure content into presentation slides"],
        charts: ["Create charts or histograms when the request and data support them"],
      },
    });

    expect(parsed.fileAgentPreview?.title).toBe("Created PowerPoint deck");
    expect(parsed.fileAgentPreview?.plannedActions?.[0]).toContain("presentation slides");
  });
});
