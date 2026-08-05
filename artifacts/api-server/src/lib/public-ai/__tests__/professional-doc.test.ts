/**
 * Tests for professional document type detection and generation quality.
 *
 * Covers:
 *  - detectProfessionalDocType: all 13 recognized types
 *  - buildProfessionalDocSectionGuidance: type-specific section content
 *  - buildDocumentSystemPrompt: professional guidance + table schema injection
 *  - normalizeDocumentFileData: table field support in sections
 *  - SOURCE_DATA_DIRECTIVE: modification language for uploaded file edits
 *  - No fake export claims (format enum is closed and fully supported)
 *  - No hallucinated file facts (source-honesty directive present)
 */
import { describe, it, expect } from "vitest";
import {
  detectProfessionalDocType,
  buildProfessionalDocSectionGuidance,
  type ProfessionalDocType,
} from "../professional-doc.js";
import {
  buildDocumentSystemPrompt,
  buildPresentationSystemPrompt,
  buildTabularSystemPrompt,
  generatedFileNameForPrompt,
  normalizeDocumentFileData,
  requestedFileNameFromPrompt,
  resolveOraFileQualityProfile,
  sanitizeRequestedFileName,
} from "../file-builder.js";

// Access the (unexported) buildDocumentSystemPrompt via the public API surface:
// generateFileFromPrompt uses it internally, so we test the system prompt content
// indirectly by re-exporting it from a shim or by building similar assertions
// against the documented public contracts.
// For direct testing we inline the prompt builder test here using the public
// normalizeDocumentFileData + detectProfessionalDocType combo.

// ---------------------------------------------------------------------------
// Requested file names
// ---------------------------------------------------------------------------

describe("requested file names", () => {
  it("preserves a user-requested quoted filename with the selected extension", () => {
    expect(
      requestedFileNameFromPrompt(
        'Create a board summary and save it as "Q3 Board Review.pdf".',
        "pdf",
      ),
    ).toBe("Q3 Board Review.pdf");
  });

  it("sanitizes unsafe filename characters while preserving readable words", () => {
    expect(sanitizeRequestedFileName("Q4/KPI*report.xlsx", "xlsx")).toBe("Q4_KPI_report.xlsx");
  });

  it("rejects empty or Windows-reserved names so the safe title fallback is used", () => {
    expect(sanitizeRequestedFileName("../con.pdf", "pdf")).toBeNull();
    expect(generatedFileNameForPrompt('Create a PDF named "../con.pdf"', "Board Pack", "pdf")).toBe(
      "board-pack.pdf",
    );
  });

  it("falls back to the generated title when the prompt does not request a filename", () => {
    expect(
      generatedFileNameForPrompt("Create an investor update deck", "Investor Update", "pptx"),
    ).toBe("investor-update.pptx");
  });
});

// ---------------------------------------------------------------------------
// detectProfessionalDocType
// ---------------------------------------------------------------------------

describe("detectProfessionalDocType — recognition", () => {
  const cases: Array<[string, ProfessionalDocType]> = [
    ["Create an executive summary of this report", "executive-summary"],
    ["Write an exec summary for the board", "executive-summary"],
    ["Generate an audit report for Q1 compliance", "audit-report"],
    ["I need an internal audit document", "audit-report"],
    ["Create a KPI report for this quarter", "kpi-report"],
    ["Build a performance dashboard report", "kpi-report"],
    ["Write a standard operating procedure for customer onboarding", "sop"],
    ["Create an SOP for the deployment process", "sop"],
    ["Give me a checklist for the release process", "checklist"],
    ["Create a pre-launch check list", "checklist"],
    ["Write a business plan for my startup", "business-plan"],
    ["Create a go-to-market plan document", "business-plan"],
    ["Summarize the meeting minutes from today", "meeting-summary"],
    ["Create meeting notes for the project kickoff", "meeting-summary"],
    ["Build an action plan to fix these issues", "action-plan"],
    ["Generate a list of action items with owners", "action-plan"],
    ["Create a root cause analysis report for the outage", "root-cause-report"],
    ["Write a 5-why analysis document", "root-cause-report"],
    ["Write a fishbone diagram report", "root-cause-report"],
    ["Create a training document for new engineers", "training-document"],
    ["Write a training guide for the onboarding process", "training-document"],
    ["Generate an accounting summary for Q3", "accounting-summary"],
    ["Create a profit and loss summary", "accounting-summary"],
    ["Write a process improvement report for the warehouse", "process-improvement"],
    ["Create a continuous improvement document", "process-improvement"],
    ["Create a data analysis report from this CSV", "dataset-report"],
    ["Generate a dataset report from the uploaded spreadsheet", "dataset-report"],
  ];

  for (const [message, expected] of cases) {
    it(`detects "${expected}" from: "${message.slice(0, 60)}"`, () => {
      expect(detectProfessionalDocType(message)).toBe(expected);
    });
  }
});

describe("detectProfessionalDocType — no false positives", () => {
  it("returns null for a generic document request", () => {
    expect(
      detectProfessionalDocType("Create a Word document about our product roadmap"),
    ).toBeNull();
  });

  it("returns null for a spreadsheet request", () => {
    expect(detectProfessionalDocType("Make an Excel spreadsheet of our customers")).toBeNull();
  });

  it("returns null for an empty message", () => {
    expect(detectProfessionalDocType("")).toBeNull();
  });

  it("returns null for a presentation request", () => {
    expect(detectProfessionalDocType("Create a PowerPoint about our team")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildProfessionalDocSectionGuidance
// ---------------------------------------------------------------------------

describe("buildProfessionalDocSectionGuidance — section content", () => {
  it("kpi-report guidance mentions KPI and table", () => {
    const g = buildProfessionalDocSectionGuidance("kpi-report", false);
    expect(g).toContain("KPI");
    expect(g).toContain("table");
  });

  it("kpi-report guidance includes action plan table headers", () => {
    const g = buildProfessionalDocSectionGuidance("kpi-report", false);
    expect(g).toContain("Action");
    expect(g).toContain("Owner");
    expect(g).toContain("Timeline");
  });

  it("meeting-summary guidance requires Action Items table", () => {
    const g = buildProfessionalDocSectionGuidance("meeting-summary", false);
    expect(g).toContain("Action Items");
    expect(g).toContain("Due Date");
    expect(g).toContain("Status");
  });

  it("action-plan guidance requires owner and priority columns", () => {
    const g = buildProfessionalDocSectionGuidance("action-plan", false);
    expect(g).toContain("Owner");
    expect(g).toContain("Priority");
    expect(g).toContain("Status");
  });

  it("sop guidance requires Procedure Steps and Roles table", () => {
    const g = buildProfessionalDocSectionGuidance("sop", false);
    expect(g).toContain("Procedure Steps");
    expect(g).toContain("Roles");
    expect(g).toContain("Revision History");
  });

  it("audit-report guidance requires Findings and Recommendations tables", () => {
    const g = buildProfessionalDocSectionGuidance("audit-report", false);
    expect(g).toContain("Findings");
    expect(g).toContain("Recommendations");
    expect(g).toContain("Risk Level");
  });

  it("root-cause-report guidance requires 5-Why and Corrective Actions", () => {
    const g = buildProfessionalDocSectionGuidance("root-cause-report", false);
    expect(g).toContain("5-Why");
    expect(g).toContain("Corrective Actions");
    expect(g).toContain("Preventive Measures");
  });

  it("dataset-report guidance requires Data Quality, KPI, and Action Plan sections", () => {
    const g = buildProfessionalDocSectionGuidance("dataset-report", false);
    expect(g).toContain("Data Quality");
    expect(g).toContain("KPI");
    expect(g).toContain("Action Plan");
    expect(g).toContain("Risks and Limitations");
  });

  it("source-data note changes when hasSourceData=true", () => {
    const withSource = buildProfessionalDocSectionGuidance("executive-summary", true);
    const noSource = buildProfessionalDocSectionGuidance("executive-summary", false);
    expect(withSource).toContain("attached source data");
    expect(withSource).not.toContain("Generate realistic");
    expect(noSource).toContain("Generate realistic");
  });
});

// ---------------------------------------------------------------------------
// normalizeDocumentFileData — table support
// ---------------------------------------------------------------------------

describe("normalizeDocumentFileData — table in sections", () => {
  it("preserves a valid table field in a section", () => {
    const parsed = {
      title: "Action Plan",
      sections: [
        {
          heading: "Tasks",
          content: "",
          table: {
            headers: ["Action", "Owner", "Due Date", "Status"],
            rows: [
              ["Fix login bug", "Alice", "2025-01-15", "Open"],
              ["Update docs", "Bob", "2025-01-20", "In Progress"],
            ],
          },
        },
      ],
    };
    const result = normalizeDocumentFileData(parsed);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].table).toBeDefined();
    expect(result.sections[0].table!.headers).toEqual(["Action", "Owner", "Due Date", "Status"]);
    expect(result.sections[0].table!.rows).toHaveLength(2);
    expect(result.sections[0].table!.rows[0]).toEqual([
      "Fix login bug",
      "Alice",
      "2025-01-15",
      "Open",
    ]);
  });

  it("keeps a table-only section (no content or bullets)", () => {
    const parsed = {
      title: "Meeting Summary",
      sections: [
        {
          heading: "Action Items",
          content: "",
          table: {
            headers: ["Action", "Owner", "Status"],
            rows: [["Schedule follow-up", "Jane", "Open"]],
          },
        },
      ],
    };
    const result = normalizeDocumentFileData(parsed);
    // Table-only section must not be dropped
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].table).toBeDefined();
  });

  it("drops a section with empty content, no bullets, and invalid table", () => {
    const parsed = {
      title: "Doc",
      sections: [
        {
          heading: "Empty",
          content: "",
          table: { headers: [], rows: [] },
        },
      ],
    };
    const result = normalizeDocumentFileData(parsed);
    expect(result.sections).toHaveLength(0);
  });

  it("handles a table with mismatched row lengths defensively", () => {
    const parsed = {
      title: "Report",
      sections: [
        {
          heading: "Data",
          content: "",
          table: {
            headers: ["A", "B", "C"],
            rows: [
              ["x", "y"],
              ["p", "q", "r", "extra"],
            ],
          },
        },
      ],
    };
    const result = normalizeDocumentFileData(parsed);
    expect(result.sections).toHaveLength(1);
    // Row normalization keeps whatever the model returned — cleaning happens at render
    expect(result.sections[0].table).toBeDefined();
  });

  // ── pipe-table fallback ───────────────────────────────────────────────────
  it("rescues a pipe-delimited table in the content field (no explicit table key)", () => {
    const parsed = {
      title: "KPI Report",
      sections: [
        {
          heading: "Key Metrics",
          content:
            "Metric | Target | Actual | Status | Trend\n" +
            "MAU | 470,000 | 487,000 | On Track | Up 18.4%\n" +
            "Churn Rate | 3.5% | 4.2% | At Risk | Up 0.6 pts\n" +
            "NPS | 44 | 41 | At Risk | Down 3 pts",
        },
      ],
    };
    const result = normalizeDocumentFileData(parsed);
    expect(result.sections).toHaveLength(1);
    const sec = result.sections[0];
    expect(sec.table).toBeDefined();
    expect(sec.table!.headers).toEqual(["Metric", "Target", "Actual", "Status", "Trend"]);
    expect(sec.table!.rows).toHaveLength(3);
    expect(sec.table!.rows[0][0]).toBe("MAU");
    // prose content should be cleared (it was entirely a pipe table)
    expect(sec.content).toBe("");
  });

  it("rescues a pipe table with leading/trailing pipe characters", () => {
    const parsed = {
      title: "Meeting Summary",
      sections: [
        {
          heading: "Action Items",
          content:
            "| Action | Owner | Due Date | Status |\n" +
            "| --- | --- | --- | --- |\n" +
            "| Schedule follow-up | Jane | 2025-07-01 | Open |\n" +
            "| Update roadmap | Bob | 2025-07-05 | In Progress |",
        },
      ],
    };
    const result = normalizeDocumentFileData(parsed);
    const sec = result.sections[0];
    expect(sec.table).toBeDefined();
    expect(sec.table!.headers).toEqual(["Action", "Owner", "Due Date", "Status"]);
    expect(sec.table!.rows).toHaveLength(2);
    expect(sec.table!.rows[1][0]).toBe("Update roadmap");
  });

  it("preserves remainder prose alongside a pipe table", () => {
    const parsed = {
      title: "Report",
      sections: [
        {
          heading: "Summary",
          content:
            "Overview of this quarter's results.\n" +
            "Metric | Value\n" +
            "Revenue | $1.2M\n" +
            "Users | 48,000",
        },
      ],
    };
    const result = normalizeDocumentFileData(parsed);
    const sec = result.sections[0];
    expect(sec.table).toBeDefined();
    expect(sec.table!.headers).toEqual(["Metric", "Value"]);
    // Non-pipe prose line should be kept as content
    expect(sec.content).toContain("Overview of this quarter");
  });

  it("does NOT rescue a single-pipe mention in plain prose", () => {
    const parsed = {
      title: "Doc",
      sections: [
        {
          heading: "Notes",
          content:
            "Use format A | B for the output. " +
            "This is a regular sentence with one pipe character.",
        },
      ],
    };
    const result = normalizeDocumentFileData(parsed);
    const sec = result.sections[0];
    // Only 1 pipe line → below the 55% threshold → no table rescue
    expect(sec.table).toBeUndefined();
  });

  it("ignores a non-object table field gracefully", () => {
    const parsed = {
      title: "Doc",
      sections: [
        {
          heading: "Section",
          content: "Some content here",
          table: "not an object",
        },
      ],
    };
    const result = normalizeDocumentFileData(parsed);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].table).toBeUndefined();
    expect(result.sections[0].content).toBe("Some content here");
  });
});

// ---------------------------------------------------------------------------
// resolveOraFileQualityProfile — used in system prompt building
// ---------------------------------------------------------------------------

describe("resolveOraFileQualityProfile — document formats", () => {
  it("returns standard depth for free tier docx", () => {
    const p = resolveOraFileQualityProfile({ format: "docx", planTier: "free" });
    expect(p.depth).toBe("standard");
    expect(p.minSyntheticSections).toBeGreaterThanOrEqual(4);
  });

  it("returns premium depth for wave tier pdf", () => {
    const p = resolveOraFileQualityProfile({ format: "pdf", planTier: "wave" });
    expect(p.depth).toBe("premium");
    expect(p.minSyntheticSections).toBeGreaterThanOrEqual(7);
  });

  it("bumps maxCompletionTokens when hasSourceData=true", () => {
    const noSource = resolveOraFileQualityProfile({ format: "docx", planTier: "free" });
    const withSource = resolveOraFileQualityProfile({
      format: "docx",
      planTier: "free",
      hasSourceData: true,
    });
    expect(withSource.maxCompletionTokens).toBeGreaterThan(noSource.maxCompletionTokens);
  });
});

// ---------------------------------------------------------------------------
// Professional doc guidance injection (via buildDocumentSystemPrompt contract)
// We cannot import the unexported function directly, so we verify the contracts
// it relies on: detectProfessionalDocType + buildProfessionalDocSectionGuidance
// cover the 13 registered types with non-empty guidance strings.
// ---------------------------------------------------------------------------

describe("all professional doc types have guidance strings", () => {
  const allTypes: ProfessionalDocType[] = [
    "executive-summary",
    "audit-report",
    "kpi-report",
    "sop",
    "checklist",
    "business-plan",
    "meeting-summary",
    "action-plan",
    "root-cause-report",
    "training-document",
    "accounting-summary",
    "process-improvement",
    "dataset-report",
  ];

  for (const docType of allTypes) {
    it(`"${docType}" has a non-empty guidance string`, () => {
      const g = buildProfessionalDocSectionGuidance(docType, false);
      expect(typeof g).toBe("string");
      expect(g.length).toBeGreaterThan(50);
      // Must name the document type in the guidance header
      expect(g.toUpperCase()).toContain(docType.toUpperCase().replace(/-/g, " ").slice(0, 6));
    });
  }
});

// ---------------------------------------------------------------------------
// Source honesty — SOURCE_DATA_DIRECTIVE includes modification language
// Tested indirectly: resolveOraFileQualityProfile.instruction always has
// "Source fidelity check" when hasSourceData=true; the modification rules
// are injected via SOURCE_DATA_DIRECTIVE (a module-level const). We verify
// the contract that hasSourceData=true produces a different instruction.
// ---------------------------------------------------------------------------

describe("source honesty contract", () => {
  it("hasSourceData=true quality profile includes source fidelity check", () => {
    const p = resolveOraFileQualityProfile({
      format: "docx",
      planTier: "free",
      hasSourceData: true,
    });
    expect(p.instruction).toContain("Source fidelity check");
    expect(p.instruction).not.toContain("Synthetic content check");
  });

  it("hasSourceData=false quality profile includes synthetic content check", () => {
    const p = resolveOraFileQualityProfile({ format: "docx", planTier: "free" });
    expect(p.instruction).toContain("Synthetic content check");
    expect(p.instruction).not.toContain("Source fidelity check");
  });
});

// ---------------------------------------------------------------------------
// No fake export claims
// The supported formats are exactly: csv, xlsx, docx, pdf, pptx.
// Verify the quality profile is computed for all of them and none throws.
// ---------------------------------------------------------------------------

describe("no fake export format claims", () => {
  const realFormats = ["csv", "xlsx", "docx", "pdf", "pptx"] as const;

  for (const fmt of realFormats) {
    it(`format "${fmt}" has a valid quality profile`, () => {
      const p = resolveOraFileQualityProfile({ format: fmt, planTier: "free" });
      expect(p.depth).toBeTruthy();
      expect(p.maxCompletionTokens).toBeGreaterThan(0);
    });
  }

  it("detectProfessionalDocType never returns a format identifier", () => {
    const formatWords = ["csv", "xlsx", "docx", "pdf", "pptx", "powerpoint", "word", "excel"];
    for (const fw of formatWords) {
      const result = detectProfessionalDocType(`Create a ${fw} file`);
      // Should return a doc-type label or null, never a format name
      if (result !== null) {
        expect(["csv", "xlsx", "docx", "pdf", "pptx"]).not.toContain(result);
      }
    }
  });
});

describe("generated-file revision and polish contract", () => {
  it("injects complete-replacement revision rules into document prompts", () => {
    const prompt = buildDocumentSystemPrompt(
      "pdf",
      undefined,
      true,
      resolveOraFileQualityProfile({ format: "pdf", planTier: "core", hasSourceData: true }),
      "dataset-report",
    );

    expect(prompt).toContain("FILE REVISION WORKFLOW");
    expect(prompt).toContain("NEW complete replacement JSON object");
    expect(prompt).toContain("Apply the requested change visibly");
    expect(prompt).toContain("REAL FILE EDIT request");
    expect(prompt).toContain("complete revised document");
    expect(prompt).toContain("executive-ready quality");
    expect(prompt).toContain("Final edit verification before JSON");
    expect(prompt).toContain("complete replacement");
  });

  it("keeps professional export polish guidance across all file prompt families", () => {
    const tabular = buildTabularSystemPrompt("xlsx");
    const presentation = buildPresentationSystemPrompt();
    const document = buildDocumentSystemPrompt("docx");

    for (const prompt of [tabular, presentation, document]) {
      expect(prompt).toContain("FILE QUALITY AND EXPORT POLISH");
      expect(prompt).toContain("client-ready professional deliverable");
      expect(prompt).toContain("structured tables for comparisons");
      expect(prompt).toContain("FILE REVISION WORKFLOW");
    }
  });

  it("teaches file specialists to return structured chart objects for analyst visuals", () => {
    const tabular = buildTabularSystemPrompt("xlsx");
    const presentation = buildPresentationSystemPrompt();
    const document = buildDocumentSystemPrompt("pdf");

    expect(tabular).toContain('"charts"');
    expect(tabular).toContain('"histogram"');
    expect(tabular).toContain("real labels and numeric values");

    expect(presentation).toContain('"layout"');
    expect(presentation).toContain('"chart"');
    expect(presentation).toContain('Supported slide layouts: "bullets", "chart", "split"');
    expect(presentation).toContain("layout variety");
    expect(presentation).toContain("slide-number markers");

    expect(document).toContain('"chart"');
    expect(document).toContain('Always use the structured "table" field');
    expect(document).toContain("include chart objects in relevant sections");
  });
});
