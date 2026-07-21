import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  detectAmbiguousEditTarget,
  planOraMultiFile,
  resolveNamedEditTarget,
  type OraMultiFilePlanInput,
} from "../multi-file-planner";
import { planOraClarification } from "../clarification-planner";
import type { CarriedFileMeta } from "../carried-docs.js";
import type { resolveCarriedFileMeta as resolveCarriedFileMetaType } from "../carried-docs.js";
import type { storeFile as storeFileType } from "../file-store.js";
import type { resolveRawOfficeEntry as resolveRawOfficeEntryType } from "../office-layout-edit.js";

/**
 * Phase 5 — Multi-File Intelligence regression suite.
 *
 * `planOraMultiFile` is the deterministic pre-LLM planner that recognizes
 * cross-file workflows over the files uploaded this conversation, assigns each
 * file a role, and steers execution (target pinning, answer override, prompt
 * directive, "working from" chips). These tests exercise the REAL pattern
 * helpers (no mocks):
 *
 *   1. Each workflow fires on its canonical phrasing with correct roles.
 *   2. Comparisons re-route to an analysis answer unless an output format is
 *      explicitly requested.
 *   3. Fewer than two resolved files, or a specialist route, always yield
 *      null — single-file behavior stays byte-identical.
 *   4. `detectAmbiguousEditTarget` asks (via the clarification planner) when
 *      two+ same-family uploads make the edit target ambiguous, and stays
 *      silent when the user names the file or wants ALL files.
 *   5. Cross-session refs never resolve (`resolveCarriedFileMeta`), so a
 *      foreign ref can never leak another user's filename into planning.
 *   6. `resolveRawOfficeEntry` honors the planner's `preferredFileRef` and
 *      falls back to the ordered scan when it does not resolve.
 */

let storeFile: typeof storeFileType;
let resolveCarriedFileMeta: typeof resolveCarriedFileMetaType;
let resolveRawOfficeEntry: typeof resolveRawOfficeEntryType;

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
  ({ storeFile } = await import("../file-store.js"));
  ({ resolveCarriedFileMeta } = await import("../carried-docs.js"));
  ({ resolveRawOfficeEntry } = await import("../office-layout-edit.js"));
});

let refCounter = 0;
function meta(filename: string, overrides?: Partial<CarriedFileMeta>): CarriedFileMeta {
  refCounter += 1;
  const lower = filename.toLowerCase();
  const rawFileType = /\.pptx?$/.test(lower)
    ? ("pptx" as const)
    : /\.docx?$/.test(lower)
      ? ("docx" as const)
      : /\.xlsx?$/.test(lower)
        ? ("xlsx" as const)
        : null;
  return {
    fileRef: `ref-${refCounter}-${filename}`,
    filename,
    rawFileType,
    isDataset: /\.(?:xlsx?|csv|tsv)$/.test(lower),
    hasRawBytes: rawFileType !== null,
    ...overrides,
  };
}

function planInput(
  message: string,
  files: CarriedFileMeta[],
  overrides?: Partial<OraMultiFilePlanInput>,
): OraMultiFilePlanInput {
  return { message, files, finalTool: "file_generation", ...overrides };
}

describe("Phase 5 multi-file planner — workflow recognition", () => {
  it("compare two documents → analysis answer with A/B roles", { timeout: 30000 }, () => {
    const a = meta("contract-a.docx");
    const b = meta("contract-b.docx");
    const plan = planOraMultiFile(
      planInput("What are the differences between these two files?", [a, b]),
    );
    expect(plan?.workflow).toBe("compare_documents");
    expect(plan?.toolOverride).toBe("answer");
    expect(plan?.targetFileRef).toBeNull();
    expect(plan?.files.map((f) => f.role)).toEqual(["comparison_a", "comparison_b"]);
    expect(plan?.usedFiles).toEqual([
      { name: "contract-a.docx", role: "comparison_a" },
      { name: "contract-b.docx", role: "comparison_b" },
    ]);
    expect(plan?.directive).toContain("contract-a.docx");
    expect(plan?.directive).toContain("contract-b.docx");
  });

  it("compare with an explicit output format keeps the file route", () => {
    const plan = planOraMultiFile(
      planInput("Compare the two contracts and give me a PDF report of the differences.", [
        meta("contract-a.docx"),
        meta("contract-b.docx"),
      ]),
    );
    expect(plan?.workflow).toBe("compare_documents");
    expect(plan?.toolOverride).toBeNull();
    expect(plan?.outputFormat).toBe("pdf");
  });

  it("compare two spreadsheets → compare_spreadsheets", () => {
    const plan = planOraMultiFile(
      planInput("What's the difference between the two spreadsheets?", [
        meta("jan-sales.xlsx"),
        meta("feb-sales.xlsx"),
      ]),
    );
    expect(plan?.workflow).toBe("compare_spreadsheets");
    expect(plan?.toolOverride).toBe("answer");
  });

  it("merge two documents → merge_documents with merge_input roles", () => {
    const plan = planOraMultiFile(
      planInput("Merge these two files into one document.", [
        meta("notes-a.docx"),
        meta("notes-b.docx"),
      ]),
    );
    expect(plan?.workflow).toBe("merge_documents");
    expect(plan?.files.every((f) => f.role === "merge_input")).toBe(true);
    expect(plan?.outputFormat).toBe("docx");
    expect(plan?.toolOverride).toBeNull();
  });

  it("combine two spreadsheets → combine_spreadsheets (xlsx out)", () => {
    const plan = planOraMultiFile(
      planInput("Combine both spreadsheets into a single workbook.", [
        meta("q1.xlsx"),
        meta("q2.xlsx"),
      ]),
    );
    expect(plan?.workflow).toBe("combine_spreadsheets");
    expect(plan?.outputFormat).toBe("xlsx");
  });

  it("named data source + one deck → data_to_presentation pinning the deck", () => {
    const data = meta("sales-data.xlsx");
    const deck = meta("pitch-deck.pptx");
    const plan = planOraMultiFile(
      planInput("Update the deck with the latest figures from the spreadsheet.", [data, deck]),
    );
    expect(plan?.workflow).toBe("data_to_presentation");
    expect(plan?.targetFileRef).toBe(deck.fileRef);
    expect(plan?.outputFormat).toBe("pptx");
    expect(plan?.usedFiles).toEqual([
      { name: "sales-data.xlsx", role: "source_data" },
      { name: "pitch-deck.pptx", role: "target_presentation" },
    ]);
  });

  it("named data source + one report → data_to_document pinning the doc", () => {
    const data = meta("metrics.csv", { rawFileType: null, hasRawBytes: false });
    const doc = meta("summary-report.docx");
    const plan = planOraMultiFile(
      planInput("Refresh the report with the new numbers from the CSV.", [data, doc]),
    );
    expect(plan?.workflow).toBe("data_to_document");
    expect(plan?.targetFileRef).toBe(doc.fileRef);
    expect(plan?.files.map((f) => f.role)).toEqual(["source_data", "target_document"]);
  });

  it("two decks + the target NAMED → pins the named deck", () => {
    const data = meta("sales-data.xlsx");
    const q3 = meta("q3-review.pptx");
    const q4 = meta("q4-forecast.pptx");
    const plan = planOraMultiFile(
      planInput("Update the q4-forecast deck using the spreadsheet data.", [data, q3, q4]),
    );
    expect(plan?.workflow).toBe("data_to_presentation");
    expect(plan?.targetFileRef).toBe(q4.fileRef);
  });

  it("two decks + target UNNAMED → no plan (clarification territory)", () => {
    const plan = planOraMultiFile(
      planInput("Update the deck using the spreadsheet data.", [
        meta("sales-data.xlsx"),
        meta("q3-review.pptx"),
        meta("q4-forecast.pptx"),
      ]),
    );
    expect(plan).toBeNull();
  });

  it("summary across all uploads → summarize_collection with reference roles", () => {
    const plan = planOraMultiFile(
      planInput("Give me a summary of all the files I uploaded.", [
        meta("intro.docx"),
        meta("appendix.pdf", { rawFileType: null, hasRawBytes: false }),
        meta("figures.xlsx"),
      ]),
    );
    expect(plan?.workflow).toBe("summarize_collection");
    expect(plan?.files.every((f) => f.role === "reference")).toBe(true);
    expect(plan?.usedFiles?.length).toBe(3);
  });

  it("archive + supporting file + analysis ask → archive_report", () => {
    const plan = planOraMultiFile(
      planInput("Analyze the uploaded archive and write a code review.", [
        meta("repo.zip", { rawFileType: null, hasRawBytes: false }),
        meta("requirements.docx"),
      ]),
    );
    expect(plan?.workflow).toBe("archive_report");
  });

  it("compare wins over merge when both intents appear", () => {
    const plan = planOraMultiFile(
      planInput("Compare the two documents and then merge them into one.", [
        meta("a.docx"),
        meta("b.docx"),
      ]),
    );
    expect(plan?.workflow).toBe("compare_documents");
  });

  it("usedFiles is capped at 5 entries", () => {
    const files = [1, 2, 3, 4, 5, 6].map((i) => meta(`part-${i}.docx`));
    const plan = planOraMultiFile(planInput("Merge all of these into one document.", files));
    expect(plan?.workflow).toBe("merge_documents");
    expect(plan!.usedFiles.length).toBeLessThanOrEqual(5);
  });
});

describe("Phase 5 multi-file planner — null guards keep single-file behavior", () => {
  it("fewer than two resolved files → null", () => {
    expect(planOraMultiFile(planInput("Compare the differences.", [meta("only.docx")]))).toBeNull();
    expect(planOraMultiFile(planInput("Compare the differences.", []))).toBeNull();
  });

  it("specialist route (image) → null even with two files", () => {
    const plan = planOraMultiFile(
      planInput("Compare the two documents.", [meta("a.docx"), meta("b.docx")], {
        finalTool: "image_generation",
      }),
    );
    expect(plan).toBeNull();
  });

  it("no cross-file intent → null (plain follow-up question)", () => {
    const plan = planOraMultiFile(
      planInput("What does the second file say about pricing?", [meta("a.docx"), meta("b.docx")]),
    );
    expect(plan).toBeNull();
  });
});

describe("Phase 5 ambiguous edit target — detection + clarification wiring", () => {
  const twoDecks = [
    { fileRef: "ref-q3", filename: "q3-review.pptx" },
    { fileRef: "ref-q4", filename: "q4-forecast.pptx" },
  ];

  it("two decks + unnamed 'update the deck' → asks which one", () => {
    const hit = detectAmbiguousEditTarget("Update the deck with our new branding.", twoDecks);
    expect(hit?.question).toContain("q3-review.pptx");
    expect(hit?.question).toContain("q4-forecast.pptx");
    expect(hit?.candidates).toEqual(["q3-review.pptx", "q4-forecast.pptx"]);
  });

  it("naming a candidate disambiguates → never asks", () => {
    expect(
      detectAmbiguousEditTarget("Update the q3-review deck with our new branding.", twoDecks),
    ).toBeNull();
  });

  it("compare/merge/summary intents use ALL files → never asks", () => {
    expect(detectAmbiguousEditTarget("Compare the two decks.", twoDecks)).toBeNull();
    expect(
      detectAmbiguousEditTarget("Merge the decks into one presentation.", twoDecks),
    ).toBeNull();
    expect(detectAmbiguousEditTarget("Give me a summary of both files.", twoDecks)).toBeNull();
  });

  it("only one file in the requested family → never asks", () => {
    const mixed = [
      { fileRef: "ref-deck", filename: "pitch.pptx" },
      { fileRef: "ref-doc", filename: "notes.docx" },
    ];
    expect(detectAmbiguousEditTarget("Update the deck for the board.", mixed)).toBeNull();
  });

  it("two documents + unnamed 'polish the report' → asks (document family)", () => {
    const twoDocs = [
      { fileRef: "ref-a", filename: "draft-v1.docx" },
      { fileRef: "ref-b", filename: "draft-v2.docx" },
    ];
    const hit = detectAmbiguousEditTarget("Polish the report before I send it.", twoDocs);
    expect(hit?.candidates).toEqual(["draft-v1.docx", "draft-v2.docx"]);
  });

  it("planOraClarification surfaces it as ambiguous_target_file (uncharged ask)", () => {
    const plan = planOraClarification({
      message: "Update the deck with our new branding.",
      carriedDocs:
        "File: q3-review.pptx\nContent:\nSlide 1 overview.\n\nFile: q4-forecast.pptx\nContent:\nSlide 1 forecast.",
      finalTool: "file_generation",
      conflictResolution: null,
      inferredFileFormat: "pptx",
      hasPendingClarification: false,
      files: twoDecks,
    });
    expect(plan?.kind).toBe("ambiguous_target_file");
    expect(plan?.question).toContain("q3-review.pptx");
    expect(plan?.pendingTaskContext.kind).toBe("ambiguous_target_file");
  });

  it("a pending clarification suppresses a second ask", () => {
    const plan = planOraClarification({
      message: "Update the deck with our new branding.",
      carriedDocs: "File: q3-review.pptx\nContent:\nSlide 1.",
      finalTool: "file_generation",
      conflictResolution: null,
      inferredFileFormat: "pptx",
      hasPendingClarification: true,
      files: twoDecks,
    });
    expect(plan).toBeNull();
  });
});

describe("Phase 5 cross-session isolation — foreign refs never resolve", () => {
  it("resolveCarriedFileMeta skips refs from another session (no userId)", async () => {
    const foreignRef = storeFile({
      sessionId: "session-owner",
      filename: "private-report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extractedText: "Confidential numbers.",
      charCount: 21,
    });
    const metas = await resolveCarriedFileMeta([foreignRef], "session-attacker");
    expect(metas).toEqual([]);
    // And with zero resolved files the planner can never produce a plan.
    expect(
      planOraMultiFile(planInput("Compare the differences between the files.", metas)),
    ).toBeNull();
  });

  it("resolveCarriedFileMeta resolves refs for the owning session in order", async () => {
    const sessionId = "session-owner-2";
    const refA = storeFile({
      sessionId,
      filename: "a.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extractedText: "A",
      charCount: 1,
    });
    const refB = storeFile({
      sessionId,
      filename: "b.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extractedText: "B",
      charCount: 1,
    });
    const metas = await resolveCarriedFileMeta([refA, refB], sessionId);
    expect(metas.map((m) => m.filename)).toEqual(["a.docx", "b.docx"]);
    expect(metas[0]?.fileRef).toBe(refA);
  });
});

describe("Phase 5 resolveRawOfficeEntry — planner-steered target pinning", () => {
  const SESSION = "session-office-target";
  const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  const FAKE_BYTES = Buffer.from("fake-office-bytes").toString("base64");

  function seedPptx(filename: string): string {
    return storeFile({
      sessionId: SESSION,
      filename,
      mimeType: PPTX_MIME,
      extractedText: `Slide 1: ${filename}`,
      charCount: 20,
      rawBase64: FAKE_BYTES,
      rawSizeBytes: 17,
      rawFileType: "pptx",
    });
  }

  it("preferredFileRef wins over the ordered documentRefs scan", async () => {
    const refA = seedPptx("first-uploaded.pptx");
    const refB = seedPptx("actually-wanted.pptx");
    const hit = await resolveRawOfficeEntry({
      message: "Update the actually-wanted deck.",
      format: "pptx",
      documentRefs: [refA, refB],
      sessionId: SESSION,
      preferredFileRef: refB,
    });
    expect(hit?.fileRef).toBe(refB);
    expect(hit?.entry.filename).toBe("actually-wanted.pptx");
  });

  it("unresolvable preferredFileRef falls back to the ordered scan", async () => {
    const refA = seedPptx("fallback-target.pptx");
    const hit = await resolveRawOfficeEntry({
      message: "Update the deck.",
      format: "pptx",
      documentRefs: [refA],
      sessionId: SESSION,
      preferredFileRef: "00000000-0000-0000-0000-000000000000",
    });
    expect(hit?.fileRef).toBe(refA);
  });

  it("preferredFileRef of the WRONG format falls back to the ordered scan", async () => {
    const xlsxRef = storeFile({
      sessionId: SESSION,
      filename: "numbers.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extractedText: "Region,Revenue",
      charCount: 14,
      rawBase64: FAKE_BYTES,
      rawSizeBytes: 17,
      rawFileType: "xlsx",
    });
    const deckRef = seedPptx("real-deck.pptx");
    const hit = await resolveRawOfficeEntry({
      message: "Update the deck.",
      format: "pptx",
      documentRefs: [xlsxRef, deckRef],
      sessionId: SESSION,
      preferredFileRef: xlsxRef,
    });
    expect(hit?.fileRef).toBe(deckRef);
  });
});

describe("Phase 5 resolveNamedEditTarget — clarification answers pin the named file", () => {
  it("answered clarification naming the SECOND deck pins the second file's ref", () => {
    // detectAmbiguousEditTarget asked; the merged continuation message now
    // names the second deck. No data source is present, so planOraMultiFile
    // yields no plan — the named-target pin must steer the edit instead.
    const first = meta("q3-review.pptx");
    const second = meta("q4-forecast.pptx");
    const merged = "Update the deck with our new branding. Use q4-forecast.pptx.";

    expect(planOraMultiFile(planInput(merged, [first, second]))?.targetFileRef ?? null).toBeNull();
    expect(resolveNamedEditTarget(merged, [first, second])).toBe(second.fileRef);
  });

  it("naming the first of two documents pins the first file's ref", () => {
    const a = meta("board-letter.docx");
    const b = meta("staff-memo.docx");
    expect(resolveNamedEditTarget("Polish board-letter please.", [a, b])).toBe(a.fileRef);
  });

  it("no filename mentioned → null (ordered scan behavior unchanged)", () => {
    const a = meta("q3-review.pptx");
    const b = meta("q4-forecast.pptx");
    expect(resolveNamedEditTarget("Update the deck with our new branding.", [a, b])).toBeNull();
  });

  it("two filenames mentioned → null (ambiguous, never guess)", () => {
    const a = meta("q3-review.pptx");
    const b = meta("q4-forecast.pptx");
    expect(resolveNamedEditTarget("Blend q3-review and q4-forecast styling.", [a, b])).toBeNull();
  });

  it("single uploaded file → null (single-file behavior stays byte-identical)", () => {
    const only = meta("solo-deck.pptx");
    expect(resolveNamedEditTarget("Update solo-deck for me.", [only])).toBeNull();
  });

  it("end-to-end: the pinned ref beats upload order in resolveRawOfficeEntry", async () => {
    const SESSION = "session-named-target";
    const FAKE = Buffer.from("fake-office-bytes").toString("base64");
    const seed = (filename: string) =>
      storeFile({
        sessionId: SESSION,
        filename,
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        extractedText: `Slide 1: ${filename}`,
        charCount: 20,
        rawBase64: FAKE,
        rawSizeBytes: 17,
        rawFileType: "pptx",
      });
    const refFirst = seed("q3-review.pptx");
    const refSecond = seed("q4-forecast.pptx");
    const files: CarriedFileMeta[] = [
      {
        fileRef: refFirst,
        filename: "q3-review.pptx",
        rawFileType: "pptx",
        isDataset: false,
        hasRawBytes: true,
      },
      {
        fileRef: refSecond,
        filename: "q4-forecast.pptx",
        rawFileType: "pptx",
        isDataset: false,
        hasRawBytes: true,
      },
    ];
    const merged = "Update the deck with our new branding. Use q4-forecast.pptx.";
    const pinned = resolveNamedEditTarget(merged, files);
    const hit = await resolveRawOfficeEntry({
      message: merged,
      format: "pptx",
      documentRefs: [refFirst, refSecond],
      sessionId: SESSION,
      preferredFileRef: pinned,
    });
    expect(hit?.fileRef).toBe(refSecond);
    expect(hit?.entry.filename).toBe("q4-forecast.pptx");
  });
});
