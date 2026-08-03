import { describe, expect, it } from "vitest";
import {
  buildDatasetAgentPreview,
  buildFileAgentPreview,
  buildFileEditConfirmationPreview,
} from "../file-agent-preview";
import { resolveFinalOraRoute } from "../route-resolution";
import type { OraRouteDecision } from "../orchestrator";

/**
 * Phase 9E — File agent format regression pack.
 *
 * Exercises buildFileAgentPreview / buildFileEditConfirmationPreview /
 * buildDatasetAgentPreview for every supported format (DOCX, PPTX, XLSX,
 * CSV, PDF, ZIP) and validates the cross-format safety invariants that must
 * never regress: canApply, failed_safe, kind/status mapping, confirmation
 * gating, content-change extraction, and the ZIP analysis guard.
 */

function routeDecision(tool: OraRouteDecision["tool"]): OraRouteDecision {
  return {
    tool,
    reason: "test",
    intent: "premium",
    confidence: "high",
    topic: "general",
  };
}

// ── DOCX ─────────────────────────────────────────────────────────────────────

describe("Phase 9E — DOCX format regressions", () => {
  it("original_edited DOCX → file_edit/applied, layout preserved, canApply true", () => {
    const preview = buildFileAgentPreview({
      format: "docx",
      fileName: "proposal-edited.docx",
      hasSourceData: true,
      sourceCount: 1,
      editQuality: {
        editMode: "original_edited",
        changes: ['Rewrote "Executive Overview" section'],
        preservedLayout: true,
        canRedesign: false,
      },
    });

    expect(preview.kind).toBe("file_edit");
    expect(preview.status).toBe("applied");
    expect(preview.title).toBe("Edited original file");
    expect(preview.canApply).toBe(true);
    expect(preview.safetyNotes).toContain("Original layout and design preserved");
    expect(preview.plannedActions).toContain('Rewrote "Executive Overview" section');
  });

  it("failed_safe DOCX → status=failed_safe, canApply=false, warning surfaced", () => {
    const preview = buildFileAgentPreview({
      format: "docx",
      fileName: "agreement.docx",
      hasSourceData: true,
      sourceCount: 1,
      editQuality: {
        editMode: "failed_safe",
        changes: [],
        warning: "Exact section heading 'Clause 4' not found in the document.",
        preservedLayout: true,
      },
    });

    expect(preview.status).toBe("failed_safe");
    expect(preview.canApply).toBe(false);
    expect(preview.safetyNotes?.some((n) => n.includes("not found"))).toBe(true);
    expect(preview.summary).toContain("unchanged");
  });

  it("DOCX unchanged return → status=unchanged, kind=file_edit", () => {
    const preview = buildFileAgentPreview({
      format: "docx",
      fileName: "report.docx",
      hasSourceData: true,
      sourceCount: 1,
      editQuality: {
        editMode: "unchanged",
        changes: [],
        preservedLayout: true,
      },
    });

    expect(preview.kind).toBe("file_edit");
    expect(preview.status).toBe("unchanged");
    expect(preview.title).toBe("Returned original file unchanged");
  });

  it("DOCX structural delete → confirmation preview with canApply and contentChanges", () => {
    const preview = buildFileEditConfirmationPreview({
      format: "docx",
      fileNames: ["contract.docx"],
      operations: ["delete"],
      requestedPreview: false,
      message: "Delete section 3 from the contract.",
    });

    expect(preview.status).toBe("needs_confirmation");
    expect(preview.kind).toBe("file_edit");
    expect(preview.canApply).toBe(true);
    expect(preview.canRedesign).toBe(true);
    expect(preview.plannedActions).toContain("Remove the requested content from the uploaded file");
    expect(preview.safetyNotes?.[0]).toContain("No downloadable file will be created");
  });

  it("DOCX quoted-pair replacement → contentChanges populated", () => {
    const preview = buildFileEditConfirmationPreview({
      format: "docx",
      fileNames: ["pitch.docx"],
      operations: ["replace"],
      requestedPreview: true,
      message: `Replace "current pricing model" with "value-based pricing" in the introduction.`,
    });

    expect(preview.contentChanges).toBeDefined();
    const change = preview.contentChanges![0];
    expect(change.label).toBe("Text replacement");
    expect(change.from).toContain("current pricing model");
    expect(change.to).toContain("value-based pricing");
  });
});

// ── PPTX ─────────────────────────────────────────────────────────────────────

describe("Phase 9E — PPTX format regressions", () => {
  it("original_edited PPTX → file_edit/applied, charts field absent", () => {
    const preview = buildFileAgentPreview({
      format: "pptx",
      fileName: "deck-edited.pptx",
      hasSourceData: true,
      sourceCount: 1,
      editQuality: {
        editMode: "original_edited",
        changes: ["Removed slide 5"],
        preservedLayout: true,
        canRedesign: true,
      },
    });

    expect(preview.kind).toBe("file_edit");
    expect(preview.status).toBe("applied");
    expect(preview.title).toBe("Edited original file");
    expect(preview.canRedesign).toBe(true);
  });

  it("PPTX redesigned → kind=file_generation, status=applied", () => {
    const preview = buildFileAgentPreview({
      format: "pptx",
      fileName: "new-deck.pptx",
      hasSourceData: true,
      sourceCount: 1,
      editQuality: {
        editMode: "redesigned",
        changes: [],
        preservedLayout: false,
      },
    });

    expect(preview.kind).toBe("file_generation");
    expect(preview.status).toBe("applied");
    expect(preview.title).toBe("Rebuilt from uploaded content");
    expect(preview.safetyNotes).toContain("Original layout was not preserved");
  });

  it("PPTX slide delete → confirmation preview with structural contentChange", () => {
    const preview = buildFileEditConfirmationPreview({
      format: "pptx",
      fileNames: ["investor-deck.pptx"],
      operations: ["delete"],
      requestedPreview: false,
      message: "Delete slide 7 from the deck.",
    });

    expect(preview.status).toBe("needs_confirmation");
    expect(preview.contentChanges).toBeDefined();
    expect(preview.contentChanges![0].label).toMatch(/slide\s*7/i);
  });

  it("PPTX reorder → confirmation preview with rearrange action", () => {
    const preview = buildFileEditConfirmationPreview({
      format: "pptx",
      fileNames: ["board-review.pptx"],
      operations: ["reorder"],
      requestedPreview: false,
    });

    expect(preview.plannedActions).toContain(
      "Rearrange the requested content in the uploaded file",
    );
    expect(preview.canApply).toBe(true);
  });

  it("PPTX requested-preview flag changes summary text", () => {
    const preview = buildFileEditConfirmationPreview({
      format: "pptx",
      fileNames: ["strategy.pptx"],
      operations: ["replace"],
      requestedPreview: true,
    });

    expect(preview.summary).toContain("wait for you to confirm");
  });

  it("PPTX generated without source data → has charts, canRedesign=false", () => {
    const preview = buildFileAgentPreview({
      format: "pptx",
      fileName: "new-slides.pptx",
      hasSourceData: false,
    });

    expect(preview.kind).toBe("file_generation");
    expect(preview.charts).toBeDefined();
    expect(preview.canRedesign).toBe(false);
  });
});

// ── XLSX ─────────────────────────────────────────────────────────────────────

describe("Phase 9E — XLSX format regressions", () => {
  it("XLSX generated → has calculations and charts sections", () => {
    const preview = buildFileAgentPreview({
      format: "xlsx",
      fileName: "budget-2026.xlsx",
      hasSourceData: false,
    });

    expect(preview.kind).toBe("file_generation");
    expect(preview.title).toBe("Created Excel workbook");
    expect(preview.calculations).toBeDefined();
    expect(preview.calculations![0]).toContain("formulas");
    expect(preview.charts).toBeDefined();
  });

  it("XLSX in-place formula edit → file_edit/applied, preservedLayout", () => {
    const preview = buildFileAgentPreview({
      format: "xlsx",
      fileName: "model-edited.xlsx",
      hasSourceData: true,
      sourceCount: 1,
      editQuality: {
        editMode: "original_edited",
        changes: ["Added SUM formula in column F"],
        preservedLayout: true,
        canRedesign: false,
      },
    });

    expect(preview.kind).toBe("file_edit");
    expect(preview.plannedActions).toContain("Added SUM formula in column F");
    expect(preview.safetyNotes).toContain("Original layout and design preserved");
  });

  it("XLSX dataset analysis → kind=data_analysis, status=planned, calculations+charts", () => {
    const preview = buildDatasetAgentPreview({
      summary: "Sales data shows consistent growth in Q3.",
      datasetProfile: { rowCount: 450, colCount: 7, sheetName: "Sales" },
      analystWorkflow: {
        chartSuggestions: [{ title: "Sales by month", chartType: "line", reason: "Trends" }],
        calculationSuggestions: [
          {
            label: "Total sales",
            expression: "SUM(sales)",
            description: "Grand total",
            columns: ["sales"],
          },
        ],
        reportSuggestions: [{ title: "Sales report", format: "pdf", description: "Shareable" }],
      },
    });

    expect(preview.kind).toBe("data_analysis");
    expect(preview.status).toBe("planned");
    expect(preview.detectedInputs).toContain("450 rows");
    expect(preview.detectedInputs).toContain("7 columns");
    expect(preview.detectedInputs).toContain("Sheet: Sales");
    expect(preview.calculations).toContain("Total sales");
    expect(preview.charts).toContain("Sales by month");
    expect(preview.outputSections).toContain("Sales report");
    expect(preview.canApply).toBe(true);
  });
});

// ── CSV ───────────────────────────────────────────────────────────────────────

describe("Phase 9E — CSV format regressions", () => {
  it("CSV dataset analysis → kind=data_analysis, no charts when workflow empty", () => {
    const preview = buildDatasetAgentPreview({
      summary: "CSV contains 200 rows of transaction data.",
      datasetProfile: { rowCount: 200, colCount: 5 },
      analystWorkflow: {},
    });

    expect(preview.kind).toBe("data_analysis");
    expect(preview.detectedInputs).toContain("200 rows");
    expect(preview.charts).toEqual([]);
    expect(preview.calculations).toEqual([]);
  });

  it("CSV dataset analysis with truncated flag adds assumption note", () => {
    const preview = buildDatasetAgentPreview({
      summary: "Very large CSV was sampled.",
      datasetProfile: { rowCount: 50000, colCount: 12 },
      analystWorkflow: {},
      truncated: true,
    });

    expect(preview.assumptions).toBeDefined();
    expect(preview.assumptions![0]).toContain("summarized from a safe sample");
  });

  it("CSV generated file → kind=file_generation, title=Created CSV file", () => {
    const preview = buildFileAgentPreview({
      format: "csv",
      fileName: "export.csv",
      hasSourceData: false,
    });

    expect(preview.kind).toBe("file_generation");
    expect(preview.title).toBe("Created CSV file");
    expect(preview.calculations).toBeUndefined();
    expect(preview.charts).toBeUndefined();
  });
});

// ── PDF ───────────────────────────────────────────────────────────────────────

describe("Phase 9E — PDF format regressions", () => {
  it("PDF generated without source → kind=report_export, has charts", () => {
    const preview = buildFileAgentPreview({
      format: "pdf",
      fileName: "annual-report.pdf",
      hasSourceData: false,
    });

    expect(preview.kind).toBe("report_export");
    expect(preview.title).toBe("Created PDF report");
    expect(preview.charts).toBeDefined();
    expect(preview.canRedesign).toBe(false);
  });

  it("PDF generated with source data → canRedesign=true, uses source actions", () => {
    const preview = buildFileAgentPreview({
      format: "pdf",
      fileName: "client-brief.pdf",
      hasSourceData: true,
      sourceCount: 2,
    });

    expect(preview.kind).toBe("report_export");
    expect(preview.detectedInputs).toContain("2 uploaded files");
    expect(preview.canRedesign).toBe(true);
    expect(preview.plannedActions).toContain("Use uploaded source content");
  });
});

// ── ZIP guard ─────────────────────────────────────────────────────────────────

describe("Phase 9E — ZIP analysis guard regressions", () => {
  const ZIP_DOCS = "File: project.zip\nContent:\nsrc/index.ts\nsrc/utils.ts\npackage.json";

  it("ZIP context routes to zip_analysis_guard regardless of edit intent", () => {
    const result = resolveFinalOraRoute({
      decision: routeDecision("file_generation"),
      message: "Edit index.ts and return the zip.",
      carriedDocs: ZIP_DOCS,
      forceSearch: false,
    });

    expect(result.conflictResolution).toBe("zip_analysis_guard");
    expect(result.inferredFileFormat).toBeNull();
  });

  it("explicit export ask bypasses the ZIP guard and routes to file output", () => {
    const result = resolveFinalOraRoute({
      decision: routeDecision("answer"),
      message: "Generate a Word document summarising the ZIP.",
      carriedDocs: ZIP_DOCS,
      forceSearch: false,
    });

    expect(result.conflictResolution).not.toBe("zip_analysis_guard");
    expect(result.inferredFileFormat).toBe("docx");
  });
});

// ── Cross-format safety invariants ───────────────────────────────────────────

describe("Phase 9E — cross-format safety invariants", () => {
  const ALL_FORMATS = ["docx", "pptx", "xlsx", "csv", "pdf"] as const;

  it("buildFileEditConfirmationPreview always returns needs_confirmation and canApply", () => {
    for (const format of ["docx", "pptx", "xlsx"] as const) {
      const preview = buildFileEditConfirmationPreview({
        format,
        fileNames: [`test.${format}`],
        operations: ["delete"],
        requestedPreview: false,
      });
      expect(preview.status, format).toBe("needs_confirmation");
      expect(preview.canApply, format).toBe(true);
      expect(preview.canRedesign, format).toBe(true);
    }
  });

  it("failed_safe always sets canApply=false regardless of format", () => {
    for (const format of ALL_FORMATS) {
      const preview = buildFileAgentPreview({
        format,
        fileName: `file.${format}`,
        hasSourceData: true,
        sourceCount: 1,
        editQuality: {
          editMode: "failed_safe",
          changes: [],
          preservedLayout: true,
        },
      });
      expect(preview.canApply, format).toBe(false);
      expect(preview.status, format).toBe("failed_safe");
    }
  });

  it("original_edited always sets canApply=true regardless of format", () => {
    for (const format of ALL_FORMATS) {
      const preview = buildFileAgentPreview({
        format,
        fileName: `file.${format}`,
        hasSourceData: true,
        sourceCount: 1,
        editQuality: {
          editMode: "original_edited",
          changes: ["Minor tweak"],
          preservedLayout: true,
        },
      });
      expect(preview.canApply, format).toBe(true);
    }
  });

  it("buildFileAgentPreview without editQuality always returns applied", () => {
    for (const format of ALL_FORMATS) {
      const preview = buildFileAgentPreview({
        format,
        fileName: `output.${format}`,
        hasSourceData: false,
      });
      expect(preview.status, format).toBe("applied");
      expect(preview.canApply, format).toBe(true);
    }
  });

  it("safetyNotes is always a non-empty array for confirmation previews", () => {
    for (const format of ["docx", "pptx", "xlsx"] as const) {
      const preview = buildFileEditConfirmationPreview({
        format,
        fileNames: [`file.${format}`],
        operations: ["delete"],
        requestedPreview: false,
      });
      expect(Array.isArray(preview.safetyNotes), format).toBe(true);
      expect(preview.safetyNotes!.length, format).toBeGreaterThan(0);
    }
  });

  it("contentChanges is never populated without a message", () => {
    for (const format of ["docx", "pptx", "xlsx"] as const) {
      const preview = buildFileEditConfirmationPreview({
        format,
        fileNames: [`file.${format}`],
        operations: ["delete"],
        requestedPreview: false,
      });
      expect(preview.contentChanges == null || preview.contentChanges.length === 0, format).toBe(
        true,
      );
    }
  });
});
