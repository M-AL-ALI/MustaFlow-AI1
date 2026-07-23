import { describe, expect, it } from "vitest";
import {
  buildDatasetAgentPreview,
  buildFileAgentPreview,
  buildFileEditConfirmationPreview,
} from "../file-agent-preview";

describe("Phase 9A file/data agent preview metadata", () => {
  it("describes an in-place Office edit without claiming a redesign", () => {
    const preview = buildFileAgentPreview({
      format: "pptx",
      fileName: "board-review-edited.pptx",
      hasSourceData: true,
      sourceCount: 1,
      editQuality: {
        editMode: "original_edited",
        changes: ['Replaced: "Q3 targets" -> "H2 goals"'],
        preservedLayout: true,
        canRedesign: true,
      },
    });

    expect(preview.kind).toBe("file_edit");
    expect(preview.status).toBe("applied");
    expect(preview.title).toBe("Edited original file");
    expect(preview.plannedActions).toContain('Replaced: "Q3 targets" -> "H2 goals"');
    expect(preview.safetyNotes).toContain("Original layout and design preserved");
  });

  it("uses failed_safe status when an edit cannot be applied safely", () => {
    const preview = buildFileAgentPreview({
      format: "docx",
      fileName: "proposal.docx",
      hasSourceData: true,
      sourceCount: 1,
      editQuality: {
        editMode: "failed_safe",
        changes: [],
        warning: "Couldn't locate the exact text to change.",
        preservedLayout: true,
      },
    });

    expect(preview.status).toBe("failed_safe");
    expect(preview.title).toBe("Could not safely apply edit");
    expect(preview.safetyNotes).toContain("Couldn't locate the exact text to change.");
    expect(preview.canApply).toBe(false);
  });

  it("describes generated spreadsheet outputs with formulas and chart capability", () => {
    const preview = buildFileAgentPreview({
      format: "xlsx",
      fileName: "budget-model.xlsx",
      hasSourceData: false,
    });

    expect(preview.kind).toBe("file_generation");
    expect(preview.status).toBe("applied");
    expect(preview.plannedActions).toContain("Organize data into workbook sheets");
    expect(preview.calculations?.[0]).toContain("formulas");
    expect(preview.charts?.[0]).toContain("charts");
  });

  it("turns dataset analyst workflow into preview sections", () => {
    const preview = buildDatasetAgentPreview({
      summary: "Revenue increased.",
      datasetProfile: { rowCount: 120, colCount: 4, sheetName: "Revenue" },
      analystWorkflow: {
        chartSuggestions: [
          {
            title: "Revenue by region",
            chartType: "bar",
            xColumn: "region",
            yColumn: "revenue",
            reason: "Compare regions.",
          },
        ],
        calculationSuggestions: [
          {
            label: "Total revenue",
            expression: "SUM(revenue)",
            description: "Total revenue.",
            columns: ["revenue"],
          },
        ],
        reportSuggestions: [
          {
            title: "Executive report",
            format: "pdf",
            description: "Shareable report.",
          },
        ],
      },
    });

    expect(preview.kind).toBe("data_analysis");
    expect(preview.detectedInputs).toContain("120 rows");
    expect(preview.calculations).toContain("Total revenue");
    expect(preview.charts).toContain("Revenue by region");
    expect(preview.outputSections).toContain("Executive report");
  });

  it("describes a confirmation-gated edit before changing the uploaded file", () => {
    const preview = buildFileEditConfirmationPreview({
      format: "pptx",
      fileNames: ["board-review.pptx"],
      operations: ["delete", "reorder"],
      requestedPreview: false,
    });

    expect(preview.kind).toBe("file_edit");
    expect(preview.status).toBe("needs_confirmation");
    expect(preview.title).toBe("Review edit before applying");
    expect(preview.detectedInputs).toContain("board-review.pptx");
    expect(preview.detectedInputs).toContain("Output: PowerPoint deck");
    expect(preview.plannedActions).toContain("Remove the requested content from the uploaded file");
    expect(preview.plannedActions).toContain(
      "Rearrange the requested content in the uploaded file",
    );
    expect(preview.safetyNotes?.[0]).toContain("No downloadable file will be created");
    expect(preview.canApply).toBe(true);
    expect(preview.canRedesign).toBe(true);
  });
});
