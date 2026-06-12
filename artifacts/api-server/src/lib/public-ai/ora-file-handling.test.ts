import { describe, it, expect } from "vitest";
import {
  safeParseFileJson,
  hasUsableFileJson,
  FileGenerationError,
  resolveOraFileQualityProfile,
  normalizeTabularFileData,
  normalizePresentationFileData,
  normalizeDocumentFileData,
} from "./file-builder.js";
import { buildDatasetContextBlock } from "./dataset-prompt.js";
import { buildCarriedDocumentContext } from "./carried-docs.js";
import { storeFile } from "./file-store.js";
import type { DatasetSummary } from "./dataset-extract.js";

function makeSummary(over: Partial<DatasetSummary> = {}): DatasetSummary {
  return {
    rowCount: 3,
    colCount: 2,
    headers: ["Name", "Amount"],
    sampleRows: [
      ["Alice", "100"],
      ["Bob", "200"],
      ["Carol", "300"],
    ],
    columnProfiles: [],
    paretoSets: [],
    sanitizedCellCount: 0,
    hiddenSheetsSkipped: 0,
    truncated: false,
    sheetName: "Data",
    ...over,
  };
}

describe("safeParseFileJson", () => {
  it("parses clean JSON", () => {
    expect(safeParseFileJson('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  it("strips ```json code fences", () => {
    expect(safeParseFileJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("strips bare ``` code fences", () => {
    expect(safeParseFileJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("repairs a response truncated mid-array, keeping complete rows", () => {
    // Simulate the model hitting the token cap mid-row.
    const truncated = '{"title":"T","headers":["A","B"],"rows":[["x","1"],["y","2"],["z","';
    const out = safeParseFileJson(truncated) as {
      title?: string;
      rows?: unknown[];
    };
    expect(out.title).toBe("T");
    expect(Array.isArray(out.rows)).toBe(true);
    // The complete rows survive; the partial trailing one is dropped.
    expect(out.rows!.length).toBe(2);
    expect(out.rows![0]).toEqual(["x", "1"]);
  });

  it("returns {} for unsalvageable garbage", () => {
    expect(safeParseFileJson("not json at all")).toEqual({});
  });

  it("returns {} for empty input", () => {
    expect(safeParseFileJson("")).toEqual({});
  });
});

describe("buildDatasetContextBlock — sheet awareness", () => {
  it("labels the analyzed sheet as the largest visible sheet", () => {
    const block = buildDatasetContextBlock("book.xlsx", makeSummary(), "summarize");
    expect(block).toContain("Sheet analyzed: Data (largest visible sheet)");
  });

  it("surfaces other visible sheets that were not analyzed", () => {
    const block = buildDatasetContextBlock(
      "book.xlsx",
      makeSummary({ otherVisibleSheets: ["Cover", "Notes"] }),
      "summarize",
    );
    expect(block).toContain("Other visible sheets NOT analyzed: Cover, Notes");
  });

  it("omits the other-sheets note when there is only one visible sheet", () => {
    const block = buildDatasetContextBlock("book.xlsx", makeSummary(), "summarize");
    expect(block).not.toContain("Other visible sheets NOT analyzed");
  });
});

describe("buildCarriedDocumentContext — datasets are carried", () => {
  it("renders a dataset upload (empty extractedText) via its summary", () => {
    const sessionId = "sess-dataset-1";
    const ref = storeFile({
      sessionId,
      filename: "sales.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extractedText: "",
      charCount: 0,
      datasetSummary: makeSummary(),
    });

    const ctx = buildCarriedDocumentContext([ref], sessionId, "make a CSV from this");
    expect(ctx).toContain("[ATTACHED FILES");
    expect(ctx).toContain("sales.xlsx");
    // Real header values from the dataset summary must be present.
    expect(ctx).toContain("Name");
    expect(ctx).toContain("Amount");
  });

  it("carries a plain-text document via extractedText", () => {
    const sessionId = "sess-doc-1";
    const ref = storeFile({
      sessionId,
      filename: "notes.txt",
      mimeType: "text/plain",
      extractedText: "The quarterly revenue was 1.2M.",
      charCount: 30,
    });

    const ctx = buildCarriedDocumentContext([ref], sessionId);
    expect(ctx).toContain("notes.txt");
    expect(ctx).toContain("quarterly revenue was 1.2M");
  });

  it("returns empty string when refs belong to another session", () => {
    const ref = storeFile({
      sessionId: "owner-session",
      filename: "secret.txt",
      mimeType: "text/plain",
      extractedText: "private",
      charCount: 7,
    });
    expect(buildCarriedDocumentContext([ref], "different-session")).toBe("");
  });

  it("returns empty string for no refs", () => {
    expect(buildCarriedDocumentContext([], "any")).toBe("");
  });
});

describe("FileGenerationError", () => {
  it("is an Error subclass carrying a user-safe message", () => {
    const err = new FileGenerationError("Could not extract the data from your file.");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FileGenerationError);
    expect(err.name).toBe("FileGenerationError");
    expect(err.message).toBe("Could not extract the data from your file.");
  });
});

describe("hasUsableFileJson", () => {
  it("accepts tabular JSON only when headers and at least one row are present", () => {
    expect(hasUsableFileJson({ headers: ["Name"], rows: [["Alice"]] }, "csv")).toBe(true);
    expect(hasUsableFileJson({ headers: ["Name"], rows: [] }, "csv")).toBe(false);
  });

  it("accepts object-shaped tabular rows after normalization", () => {
    expect(hasUsableFileJson({ columns: ["Name"], rows: [{ Name: "Alice" }] }, "xlsx")).toBe(true);
  });

  it("accepts presentations only when at least one slide has content", () => {
    expect(hasUsableFileJson({ slides: [{ heading: "Plan", bullets: ["Launch"] }] }, "pptx")).toBe(
      true,
    );
    expect(hasUsableFileJson({ slides: [{ heading: "", bullets: [] }] }, "pptx")).toBe(false);
  });

  it("accepts documents only when at least one section has content or bullets", () => {
    expect(
      hasUsableFileJson({ sections: [{ heading: "Overview", content: "Summary" }] }, "docx"),
    ).toBe(true);
    expect(hasUsableFileJson({ sections: [{ heading: "Overview", content: "" }] }, "docx")).toBe(
      false,
    );
  });
});

describe("file JSON normalization", () => {
  it("repairs tabular headers, object rows, duplicate rows, and column types", () => {
    const data = normalizeTabularFileData({
      title: " Sales export ",
      columns: ["customer_name", "amount", "amount"],
      rows: [
        { customer_name: "Alice", amount: "$100.00" },
        ["Bob", "200", "300"],
        ["Bob", "200", "300"],
        ["", "", ""],
      ],
    });

    expect(data.title).toBe("Sales export");
    expect(data.headers).toEqual(["Customer Name", "Amount", "Amount 2"]);
    expect(data.rows).toEqual([
      ["Alice", "$100.00", "$100.00"],
      ["Bob", "200", "300"],
    ]);
    expect(data.columnTypes).toEqual(["text", "currency", "currency"]);
  });

  it("normalizes presentation slides and strips bullet markdown", () => {
    const data = normalizePresentationFileData({
      title: "Launch plan",
      slides: [
        { heading: " Roadmap ", bullets: ["- Prepare beta", "* Prepare beta", "placeholder text"] },
        { heading: "", bullets: [] },
        "Measure results\nShare findings",
      ],
    });

    expect(data.slides).toEqual([
      { heading: "Roadmap", bullets: ["Prepare beta"] },
      { heading: "Slide 3", bullets: ["Measure results", "Share findings"] },
    ]);
  });

  it("normalizes document sections and promotes top-level content", () => {
    expect(
      normalizeDocumentFileData({
        title: " Report ",
        content: "Executive summary.",
      }).sections,
    ).toEqual([{ heading: "Overview", content: "Executive summary." }]);

    const data = normalizeDocumentFileData({
      sections: [{ heading: " Next steps ", content: "", bullets: ["* Launch beta", "todo item"] }],
    });
    expect(data.sections).toEqual([
      { heading: "Next steps", content: "", bullets: ["Launch beta"] },
    ]);
  });
});

describe("resolveOraFileQualityProfile", () => {
  it("scales generated file depth by Ora plan", () => {
    const free = resolveOraFileQualityProfile({
      format: "pptx",
      planTier: "free",
    });
    const core = resolveOraFileQualityProfile({
      format: "pptx",
      planTier: "core",
    });
    const wave = resolveOraFileQualityProfile({
      format: "pptx",
      planTier: "wave",
    });

    expect(free.depth).toBe("standard");
    expect(core.depth).toBe("polished");
    expect(wave.depth).toBe("premium");
    expect(core.minSyntheticSlides).toBeGreaterThan(free.minSyntheticSlides);
    expect(wave.minSyntheticSlides).toBeGreaterThan(core.minSyntheticSlides);
    expect(wave.maxCompletionTokens).toBeGreaterThan(core.maxCompletionTokens);
  });

  it("adds source-data budget and fidelity guidance when building from uploads", () => {
    const plain = resolveOraFileQualityProfile({
      format: "xlsx",
      planTier: "core",
      hasSourceData: false,
    });
    const sourced = resolveOraFileQualityProfile({
      format: "xlsx",
      planTier: "core",
      hasSourceData: true,
    });

    expect(sourced.maxCompletionTokens).toBeGreaterThan(plain.maxCompletionTokens);
    expect(sourced.instruction).toContain("Source fidelity check");
    expect(sourced.instruction).toContain("never replace missing source facts");
  });
});
