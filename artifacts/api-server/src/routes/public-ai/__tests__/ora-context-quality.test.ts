/**
 * Ora context quality tests.
 *
 * Exercises the four gaps identified in the Ora Memory + Context Quality
 * Upgrade phase:
 *   1. Cross-session file isolation in file-store
 *   2. File carryover through buildCarriedDocumentContext (text + dataset)
 *   3. Multi-file directory header when 2+ files resolve
 *   4. File-availability system prompt addendum (available / expired / absent)
 *   5. documentContext forwarded to runOraWebSearch via buildInstructions
 *
 * These are pure unit tests. No Express server is spun up and no AI provider
 * calls are made — all AI dependencies are mocked at the module level.
 */

import { describe, it, expect, vi } from "vitest";
import { storeFile, getFile } from "../../../lib/public-ai/file-store.js";
import {
  buildCarriedDocumentContext,
  MAX_CARRIED_DOC_CHARS,
} from "../../../lib/public-ai/carried-docs.js";
import { buildFileContextAddendum } from "../chat.js";
import { buildInstructions } from "../../../lib/public-ai/web-search.js";

// ── Module-level mocks required by the chat.ts import path ───────────────────
// chat.ts imports a wide dependency tree. We only need buildFileContextAddendum,
// so we stub the heavyweight transitive deps that would fail in unit-test scope.

vi.mock("../../../lib/public-ai/model-router.js", () => ({
  oraModelForChat: vi.fn().mockReturnValue("gpt-4o-mini"),
  oraModelForDeepChat: vi.fn().mockReturnValue("gpt-4o"),
  openAiModelForOraSearch: vi.fn().mockReturnValue("gpt-4o-mini"),
  isDeepSeekAvailable: vi.fn().mockReturnValue(false),
  MODEL_DEFAULTS: { maxTokens: 4096 },
}));

vi.mock("@workspace/db", () => ({
  db: {},
  pool: { query: vi.fn() },
}));

vi.mock("../../../lib/auth.js", () => ({
  requireAuth: vi.fn((_req, _res, next: () => void) => next()),
  optionalAuth: vi.fn((_req, _res, next: () => void) => next()),
}));

vi.mock("../../../lib/public-ai/prompt.js", () => ({
  buildSystemPrompt: vi.fn().mockReturnValue("system"),
  buildImageSystemPrompt: vi.fn().mockReturnValue("image-system"),
}));

vi.mock("../../../lib/public-ai/memory.js", () => ({
  buildMemoryContext: vi.fn().mockResolvedValue({ text: "", used: [] }),
}));

vi.mock("../../../lib/public-ai/profile.js", () => ({
  buildProfileContext: vi.fn().mockReturnValue(""),
  extractUserProfile: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../../lib/public-ai/conversation-summary.js", () => ({
  updateConversationSummary: vi.fn().mockResolvedValue(""),
}));

vi.mock("../../../lib/public-ai/expertise.js", () => ({
  resolveExpertiseProfile: vi.fn().mockReturnValue({ systemAddendum: "" }),
}));

vi.mock("openai", () => {
  const mockCreate = vi.fn().mockResolvedValue({
    choices: [{ message: { content: "ok" } }],
  });
  const OpenAI = vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
    audio: { speech: { create: vi.fn() }, transcriptions: { create: vi.fn() } },
    images: { generate: vi.fn(), edit: vi.fn() },
    responses: { create: vi.fn() },
  }));
  return { default: OpenAI };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(): string {
  return crypto.randomUUID();
}

function storeText(sessionId: string, filename: string, text: string): string {
  return storeFile({
    sessionId,
    filename,
    mimeType: "text/plain",
    extractedText: text,
    charCount: text.length,
  });
}

// ── 1. Cross-session file isolation ──────────────────────────────────────────

describe("file-store cross-session isolation", () => {
  it("returns null when sessionId does not match the stored entry", () => {
    const ownerSession = makeSession();
    const otherSession = makeSession();
    const ref = storeText(ownerSession, "secret.txt", "confidential data");

    expect(getFile(ref, otherSession)).toBeNull();
  });

  it("returns the entry for the correct owning session", () => {
    const session = makeSession();
    const ref = storeText(session, "report.txt", "hello world");

    const entry = getFile(ref, session);
    expect(entry).not.toBeNull();
    expect(entry?.extractedText).toBe("hello world");
  });

  it("returns null for a ref that was never stored", () => {
    expect(getFile(crypto.randomUUID(), makeSession())).toBeNull();
  });
});

// ── 2. File carryover (text documents) ───────────────────────────────────────

describe("buildCarriedDocumentContext — text file carryover", () => {
  it("returns empty string when refs list is empty", async () => {
    expect(await buildCarriedDocumentContext([], makeSession())).toBe("");
  });

  it("returns empty string when the ref belongs to a different session", async () => {
    const ownerSession = makeSession();
    const ref = storeText(ownerSession, "notes.txt", "important notes");
    const otherSession = makeSession();

    expect(await buildCarriedDocumentContext([ref], otherSession)).toBe("");
  });

  it("returns formatted block containing the file content", async () => {
    const session = makeSession();
    const ref = storeText(session, "report.txt", "quarterly earnings: 42");

    const result = await buildCarriedDocumentContext([ref], session);

    expect(result).toContain("quarterly earnings: 42");
    expect(result).toContain("File: report.txt");
    expect(result).toContain("[ATTACHED FILES");
    expect(result).toContain("[END OF ATTACHED FILES]");
  });

  it("adds an editable PowerPoint blueprint so deck edits return a revised deck", async () => {
    const session = makeSession();
    const ref = storeFile({
      sessionId: session,
      filename: "board-review.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      extractedText: ["Slide 1:", "- Executive Summary", "Slide 2:", "- Old Pricing"].join("\n"),
      charCount: 64,
    });

    const result = await buildCarriedDocumentContext([ref], session);

    expect(result).toContain("[EDITABLE SOURCE BLUEPRINT]");
    expect(result).toContain("Type: PowerPoint / slide deck.");
    expect(result).toContain("Detected slide markers: 2.");
    expect(result).toContain("Return one complete revised PPTX-ready deck");
    expect(result).toContain("Follow any EDITABLE SOURCE BLUEPRINT");
  });

  it("adds an editable workbook blueprint for spreadsheet chart and calculation edits", async () => {
    const session = makeSession();
    const ref = storeText(session, "sales-workbook.xlsx", "Region,Revenue\nNorth,120\nSouth,80");

    const result = await buildCarriedDocumentContext([ref], session);

    expect(result).toContain("Type: spreadsheet / workbook.");
    expect(result).toContain("Derive formulas, totals, charts, histograms, and dashboards");
    expect(result).toContain("Return one complete revised CSV/XLSX-ready table or workbook");
  });

  it("neutralises triple-quote delimiters in file content", async () => {
    const session = makeSession();
    const ref = storeText(session, "sneaky.txt", 'say """ and escape');

    const result = await buildCarriedDocumentContext([ref], session);

    // The raw """ must not appear unescaped inside the block.
    // The sanitiser inserts a zero-width space: " \u200b"" ".
    expect(result).not.toContain('"""say"""');
    expect(result).toContain("\u200b");
  });

  it("respects the character budget (MAX_CARRIED_DOC_CHARS)", async () => {
    const session = makeSession();
    const bigText = "x".repeat(MAX_CARRIED_DOC_CHARS + 5_000);
    const ref = storeText(session, "huge.txt", bigText);

    const result = await buildCarriedDocumentContext([ref], session);

    // The output itself must not exceed budget + reasonable overhead.
    expect(result.length).toBeLessThan(MAX_CARRIED_DOC_CHARS + 500);
  });
});

// ── 3. Dataset carryover ─────────────────────────────────────────────────────

describe("buildCarriedDocumentContext — dataset file carryover", () => {
  it("uses datasetSummary when extractedText is empty", async () => {
    const session = makeSession();
    const ref = storeFile({
      sessionId: session,
      filename: "sales.csv",
      mimeType: "text/csv",
      extractedText: "",
      charCount: 0,
      datasetSummary: {
        rowCount: 100,
        colCount: 3,
        headers: ["date", "revenue", "region"],
        sampleRows: [["2024-01-01", "1000", "North"]],
        columnProfiles: [
          { index: 0, type: "date", nullCount: 0, uniqueCount: 100 },
          {
            index: 1,
            type: "numeric",
            nullCount: 0,
            uniqueCount: 90,
            min: 100,
            max: 9999,
            mean: 1000,
            sum: 100000,
            stddev: 50,
          },
          {
            index: 2,
            type: "string",
            nullCount: 0,
            uniqueCount: 5,
            topCategories: [{ value: "North", count: 40 }],
          },
        ],
        paretoSets: [],
        sanitizedCellCount: 0,
        hiddenSheetsSkipped: 0,
        truncated: false,
      },
    });

    const result = await buildCarriedDocumentContext([ref], session);

    expect(result).toContain("sales.csv");
    expect(result).toContain("100");
    expect(result).toContain("[ATTACHED FILES");
  });

  it("skips an entry whose extractedText and datasetSummary are both absent", async () => {
    const session = makeSession();
    const ref = storeFile({
      sessionId: session,
      filename: "empty.txt",
      mimeType: "text/plain",
      extractedText: "",
      charCount: 0,
    });

    expect(await buildCarriedDocumentContext([ref], session)).toBe("");
  });
});

// ── 4. Multi-file directory header ────────────────────────────────────────────

describe("buildCarriedDocumentContext — multi-file directory", () => {
  it("includes a numbered directory when 2 files resolve", async () => {
    const session = makeSession();
    const ref1 = storeText(session, "report.pdf", "annual report content");
    const ref2 = storeText(session, "data.csv", "col1,col2\n1,2");

    const result = await buildCarriedDocumentContext([ref1, ref2], session);

    expect(result).toContain("[1]");
    expect(result).toContain("[2]");
    expect(result).toContain("report.pdf");
    expect(result).toContain("data.csv");
    // Verify "Use the correct one based on context" disambiguation phrase.
    expect(result).toContain("Use the correct one based on context");
  });

  it("includes both file blocks in the output when 2 files are present", async () => {
    const session = makeSession();
    const ref1 = storeText(session, "a.txt", "alpha content");
    const ref2 = storeText(session, "b.txt", "beta content");

    const result = await buildCarriedDocumentContext([ref1, ref2], session);

    expect(result).toContain("alpha content");
    expect(result).toContain("beta content");
  });

  it("does NOT include a numbered directory for a single file", async () => {
    const session = makeSession();
    const ref = storeText(session, "solo.txt", "only file");

    const result = await buildCarriedDocumentContext([ref], session);

    expect(result).not.toContain("[1]");
    expect(result).not.toContain("Use the correct one based on context");
    expect(result).toContain("solo.txt");
  });
});

// ── 5. File-availability system prompt addendum ───────────────────────────────

describe("buildFileContextAddendum", () => {
  it("returns empty string when no documentRefs were sent", () => {
    expect(buildFileContextAddendum("", [])).toBe("");
    expect(buildFileContextAddendum("some content", [])).toBe("");
  });

  it("returns available-file addendum when carriedDocs is non-empty", () => {
    const carriedDocs = [
      "[ATTACHED FILES]",
      "File: notes.txt",
      '"""',
      "my important notes",
      '"""',
      "[END OF ATTACHED FILES]",
    ].join("\n");

    const result = buildFileContextAddendum(carriedDocs, ["ref-uuid-1"]);

    expect(result).toContain("Do NOT ask");
    expect(result.toLowerCase()).not.toContain("expired");
  });

  it("counts 1 file correctly in the addendum message", () => {
    const carriedDocs = 'File: solo.txt\n"""\ncontent\n"""';
    const result = buildFileContextAddendum(carriedDocs, ["ref-1"]);

    expect(result).toContain("1 uploaded file");
    expect(result).not.toContain("1 uploaded files");
  });

  it("counts 2 files correctly in the addendum message", () => {
    const carriedDocs = ['File: a.txt\n"""\nalpha\n"""', 'File: b.txt\n"""\nbeta\n"""'].join("\n");
    const result = buildFileContextAddendum(carriedDocs, ["ref-1", "ref-2"]);

    expect(result).toContain("2 uploaded files");
  });

  it("returns expired-file notice when documentRefs present but carriedDocs is empty", () => {
    const result = buildFileContextAddendum("", ["ref-uuid-1"]);

    expect(result.toLowerCase()).toContain("expired");
    expect(result).not.toContain("Do NOT ask");
  });

  it("returns expired-file notice when carriedDocs is whitespace-only", () => {
    const result = buildFileContextAddendum("   \n  ", ["ref-uuid-1"]);

    expect(result.toLowerCase()).toContain("expired");
  });
});

// ── 6. documentContext forwarded in web-search buildInstructions ──────────────

describe("buildInstructions — documentContext injection", () => {
  it("includes documentContext in the built instruction string", () => {
    const docCtx = '[ATTACHED FILES]\nFile: data.csv\n"""\ncol1,val1\n"""';
    const result = buildInstructions(undefined, undefined, undefined, undefined, docCtx);

    expect(result).toContain(docCtx);
  });

  it("does not include document section when documentContext is absent", () => {
    const result = buildInstructions(undefined, undefined, undefined, undefined, undefined);

    expect(result).not.toContain("[ATTACHED FILES]");
  });

  it("does not include document section when documentContext is empty string", () => {
    const result = buildInstructions(undefined, undefined, undefined, undefined, "");

    expect(result).not.toContain("[ATTACHED FILES]");
  });

  it("appends documentContext after personalContext, not before", () => {
    const personal = "User lives in Berlin.";
    const doc = '[ATTACHED FILES]\nFile: schema.sql\n"""\nCREATE TABLE\n"""';
    const result = buildInstructions(undefined, personal, undefined, undefined, doc);

    const personalIdx = result.indexOf(personal);
    const docIdx = result.indexOf("[ATTACHED FILES]");

    expect(personalIdx).toBeGreaterThan(-1);
    expect(docIdx).toBeGreaterThan(-1);
    expect(docIdx).toBeGreaterThan(personalIdx);
  });
});
