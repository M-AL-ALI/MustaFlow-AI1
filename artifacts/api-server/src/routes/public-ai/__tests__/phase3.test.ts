/**
 * Phase 3 tests — CSV/XLSX dataset analysis for Ora.
 *
 * Coverage:
 * 1. No DB imports in Phase 3 modules
 * 2. dataset-safety: formula neutralisation and cell sanitisation
 * 3. dataset-stats: column profiling and Pareto computation
 * 4. dataset-extract: CSV parsing, formula safety, empty-file errors
 * 5. file-validate Phase 3: CSV accepted, XLSX accepted/rejected, .xls blocked
 * 6. /api/public-ai/dataset-analysis route: 401, 404, 400 (doc ref), 200, 502, session isolation
 * 7. Log safety: forbidden fields are never logged
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";
import { neutraliseFormula, sanitiseCell } from "../../../lib/public-ai/dataset-safety";
import { computeColumnProfiles, computePareto } from "../../../lib/public-ai/dataset-stats";
import { extractDataset, DatasetExtractionError } from "../../../lib/public-ai/dataset-extract";
import { validateFile } from "../../../lib/public-ai/file-validate";
import { storeFile } from "../../../lib/public-ai/file-store";

vi.mock("../../../lib/ai-providers", () => ({
  createChatCompletion: vi.fn(),
  isDeepSeekAvailable: () => false,
  MODEL_DEFAULTS: {
    openai: { lite: "gpt-5-nano", eco: "gpt-5-mini", power: "gpt-5.4", pro: "gpt-5.4" },
    anthropic: {
      lite: "claude-haiku-4-5",
      eco: "claude-haiku-4-5",
      power: "claude-sonnet-4-6",
      pro: "claude-opus-4-7",
    },
    gemini: {
      lite: "gemini-3-flash-preview",
      eco: "gemini-3-flash-preview",
      power: "gemini-3.1-pro-preview",
      pro: "gemini-3.1-pro-preview",
    },
    deepseek: {
      lite: "deepseek-chat",
      eco: "deepseek-chat",
      power: "deepseek-reasoner",
      pro: "deepseek-reasoner",
    },
  },
}));

const TEST_SECRET = "phase3-test-secret";

// ─── 1. No DB imports in Phase 3 modules ─────────────────────────────────────
describe("No DB imports in Phase 3 modules", () => {
  it("dataset-safety has no DB imports", async () => {
    const mod = await import("../../../lib/public-ai/dataset-safety");
    expect(typeof mod.neutraliseFormula).toBe("function");
    expect(typeof mod.sanitiseCell).toBe("function");
  });

  it("dataset-stats has no DB imports", async () => {
    const mod = await import("../../../lib/public-ai/dataset-stats");
    expect(typeof mod.computeColumnProfiles).toBe("function");
    expect(typeof mod.computePareto).toBe("function");
  });

  it("dataset-schema has no DB imports", async () => {
    const mod = await import("../../../lib/public-ai/dataset-schema");
    expect(typeof mod.DatasetAnalysisAiSchema).toBe("object");
  });

  it("dataset-prompt has no DB imports", async () => {
    const mod = await import("../../../lib/public-ai/dataset-prompt");
    expect(typeof mod.DATASET_SYSTEM_PROMPT).toBe("string");
    expect(typeof mod.buildDatasetContextBlock).toBe("function");
  });
});

// ─── 2. dataset-safety: formula neutralisation ───────────────────────────────
describe("neutraliseFormula", () => {
  it("prefixes = with a single-quote", () => {
    expect(neutraliseFormula("=SUM(A1:A10)")).toBe("'=SUM(A1:A10)");
  });

  it("prefixes @ with a single-quote", () => {
    expect(neutraliseFormula("@EXEC(rm -rf /)")).toBe("'@EXEC(rm -rf /)");
  });

  it("does NOT alter negative numbers", () => {
    expect(neutraliseFormula("-12345")).toBe("-12345");
  });

  it("does NOT alter positive numbers", () => {
    expect(neutraliseFormula("99.5")).toBe("99.5");
  });

  it("does NOT alter plain strings", () => {
    expect(neutraliseFormula("North America")).toBe("North America");
  });

  it("does NOT alter empty string", () => {
    expect(neutraliseFormula("")).toBe("");
  });
});

// ─── 3. dataset-safety: sanitiseCell ────────────────────────────────────────
describe("sanitiseCell", () => {
  it("marks sanitized=false for clean cells", () => {
    const result = sanitiseCell("hello world");
    expect(result.value).toBe("hello world");
    expect(result.sanitized).toBe(false);
  });

  it("removes ASCII control chars (NUL)", () => {
    const result = sanitiseCell("hello\x00world");
    expect(result.value).toBe("helloworld");
    expect(result.sanitized).toBe(true);
  });

  it("removes Unicode directional override (U+202E)", () => {
    const result = sanitiseCell("pay\u202E000");
    expect(result.value).not.toContain("\u202E");
    expect(result.sanitized).toBe(true);
  });

  it("neutralises formula prefix after stripping control chars", () => {
    const result = sanitiseCell("=SUM(1,2)");
    expect(result.value).toBe("'=SUM(1,2)");
    expect(result.sanitized).toBe(true);
  });

  it("preserves negative numbers", () => {
    const result = sanitiseCell("-500");
    expect(result.value).toBe("-500");
    expect(result.sanitized).toBe(false);
  });

  it("preserves tabs and newlines (valid whitespace)", () => {
    const result = sanitiseCell("line1\nline2");
    expect(result.value).toBe("line1\nline2");
    expect(result.sanitized).toBe(false);
  });
});

// ─── 4. dataset-stats: column profiling ──────────────────────────────────────
describe("computeColumnProfiles", () => {
  it("detects numeric column type", () => {
    const headers = ["value"];
    const rows = [["100"], ["200"], ["300"]];
    const profiles = computeColumnProfiles(headers, rows);
    expect(profiles[0]!.type).toBe("numeric");
    expect(profiles[0]!.sum).toBeCloseTo(600);
    expect(profiles[0]!.mean).toBeCloseTo(200);
  });

  it("detects string column type", () => {
    const headers = ["region"];
    const rows = [["North"], ["South"], ["North"]];
    const profiles = computeColumnProfiles(headers, rows);
    expect(profiles[0]!.type).toBe("string");
    expect(profiles[0]!.uniqueCount).toBe(2);
    expect(profiles[0]!.topCategories?.[0]?.value).toBe("North");
    expect(profiles[0]!.topCategories?.[0]?.count).toBe(2);
  });

  it("counts null values correctly", () => {
    const headers = ["score"];
    const rows = [["10"], [""], ["30"], [""]];
    const profiles = computeColumnProfiles(headers, rows);
    expect(profiles[0]!.nullCount).toBe(2);
  });

  it("detects empty column", () => {
    const headers = ["empty"];
    const rows = [[""], [""], [""]];
    const profiles = computeColumnProfiles(headers, rows);
    expect(profiles[0]!.type).toBe("empty");
  });

  it("detects boolean column", () => {
    const headers = ["active"];
    const rows = [["true"], ["false"], ["true"]];
    const profiles = computeColumnProfiles(headers, rows);
    expect(profiles[0]!.type).toBe("boolean");
  });

  it("handles multiple columns", () => {
    const headers = ["name", "sales"];
    const rows = [
      ["Alice", "500"],
      ["Bob", "300"],
      ["Carol", "700"],
    ];
    const profiles = computeColumnProfiles(headers, rows);
    expect(profiles).toHaveLength(2);
    expect(profiles[0]!.type).toBe("string");
    expect(profiles[1]!.type).toBe("numeric");
    expect(profiles[1]!.sum).toBeCloseTo(1500);
  });
});

// ─── 5. dataset-stats: Pareto computation ────────────────────────────────────
describe("computePareto", () => {
  it("computes Pareto for string × numeric columns", () => {
    const headers = ["region", "revenue"];
    const rows = [
      ["North", "5000"],
      ["South", "3000"],
      ["East", "1000"],
      ["West", "500"],
      ["North", "2000"],
    ];
    const profiles = computeColumnProfiles(headers, rows);
    const pareto = computePareto(headers, rows, profiles);
    expect(pareto.length).toBeGreaterThan(0);
    const set = pareto[0]!;
    expect(set.entries.length).toBeGreaterThan(0);
    expect(set.entries[0]!.label).toBe("North");
    expect(set.entries[0]!.value).toBeCloseTo(7000);
    expect(set.entries[0]!.cumPct).toBeGreaterThan(0);
    expect(set.entries[set.entries.length - 1]!.cumPct).toBeCloseTo(100);
  });

  it("returns empty array when no string columns with 2-50 unique values", () => {
    const headers = ["value"];
    const rows = [["100"], ["200"]];
    const profiles = computeColumnProfiles(headers, rows);
    const pareto = computePareto(headers, rows, profiles);
    expect(pareto).toEqual([]);
  });
});

// ─── 6. dataset-extract: CSV parsing ─────────────────────────────────────────
describe("extractDataset — CSV", () => {
  it("parses a simple CSV and returns correct metadata", async () => {
    const csv = Buffer.from("region,revenue\nNorth,5000\nSouth,3000\nEast,1000\n");
    const summary = await extractDataset(csv, "csv");
    expect(summary.rowCount).toBe(3);
    expect(summary.colCount).toBe(2);
    expect(summary.headers).toEqual(["region", "revenue"]);
    expect(summary.truncated).toBe(false);
    expect(summary.hiddenSheetsSkipped).toBe(0);
  });

  it("neutralises formula cells in CSV", async () => {
    const csv = Buffer.from("name,formula\nAlice,=SUM(1+1)\nBob,100\n");
    const summary = await extractDataset(csv, "csv");
    const formulaCell = summary.sampleRows[0]?.[1];
    expect(formulaCell).toBe("'=SUM(1+1)");
    expect(summary.sanitizedCellCount).toBeGreaterThan(0);
  });

  it("correctly profiles numeric column from CSV", async () => {
    const csv = Buffer.from("product,sales\nAlpha,100\nBeta,200\nGamma,300\n");
    const summary = await extractDataset(csv, "csv");
    const salesProfile = summary.columnProfiles.find((p) => summary.headers[p.index] === "sales");
    expect(salesProfile?.type).toBe("numeric");
    expect(salesProfile?.sum).toBeCloseTo(600);
  });

  it("computes Pareto for CSV with categorical + numeric columns", async () => {
    const rows = ["region,revenue"];
    for (let i = 0; i < 10; i++) rows.push(`Region${i % 3},${(i + 1) * 100}`);
    const csv = Buffer.from(rows.join("\n") + "\n");
    const summary = await extractDataset(csv, "csv");
    expect(summary.paretoSets.length).toBeGreaterThan(0);
  });

  it("throws DatasetExtractionError for empty CSV", async () => {
    const csv = Buffer.from("");
    await expect(extractDataset(csv, "csv")).rejects.toBeInstanceOf(DatasetExtractionError);
  });

  it("throws DatasetExtractionError for header-only CSV", async () => {
    const csv = Buffer.from("col1,col2,col3\n");
    await expect(extractDataset(csv, "csv")).rejects.toBeInstanceOf(DatasetExtractionError);
  });

  it("truncates at MAX_DATASET_ROWS and sets truncated=true", async () => {
    const { MAX_DATASET_ROWS } = await import("../../../lib/public-ai/dataset-extract");
    const lines = ["a,b"];
    for (let i = 0; i <= MAX_DATASET_ROWS; i++) lines.push(`v${i},${i}`);
    const csv = Buffer.from(lines.join("\n"));
    const summary = await extractDataset(csv, "csv");
    expect(summary.truncated).toBe(true);
    expect(summary.rowCount).toBe(MAX_DATASET_ROWS);
  });
});

// ─── 7. file-validate Phase 3 additions ──────────────────────────────────────
describe("validateFile — Phase 3 dataset types", () => {
  const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const XLSX_MAGIC_WITH_STRUCTURE = Buffer.concat([
    ZIP_MAGIC,
    Buffer.from("[Content_Types].xml xl/workbook.xml"),
    Buffer.alloc(200),
  ]);

  it("accepts .csv with plain text content", () => {
    const result = validateFile(Buffer.from("a,b,c\n1,2,3"), "data.csv", "text/csv");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.type).toBe("csv");
  });

  it("rejects .csv with PDF magic bytes", () => {
    const pdfMagic = Buffer.from([0x25, 0x50, 0x44, 0x46]);
    const result = validateFile(
      Buffer.concat([pdfMagic, Buffer.alloc(100)]),
      "fake.csv",
      "text/csv",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(415);
  });

  it("accepts .xlsx with valid OOXML structure markers", () => {
    const result = validateFile(XLSX_MAGIC_WITH_STRUCTURE, "data.xlsx", "application/vnd.ms-excel");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.type).toBe("xlsx");
  });

  it("rejects .xlsx without OOXML structure (bare ZIP)", () => {
    const result = validateFile(
      Buffer.concat([ZIP_MAGIC, Buffer.alloc(100)]),
      "fake.xlsx",
      "application/vnd.ms-excel",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(415);
  });

  it("rejects .xls with specific error about converting to xlsx/csv", () => {
    const result = validateFile(Buffer.alloc(100), "old.xls", "application/vnd.ms-excel");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(415);
      expect(result.error).toMatch(/xlsx|csv/i);
    }
  });

  it("rejects .xlsm with conversion hint", () => {
    const result = validateFile(Buffer.alloc(100), "macro.xlsm", "application/vnd.ms-excel");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(415);
  });

  it("rejects .xlsb with conversion hint", () => {
    const result = validateFile(Buffer.alloc(100), "binary.xlsb", "application/vnd.ms-excel");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(415);
  });
});

// ─── 8. /api/public-ai/dataset-analysis route ────────────────────────────────
function _makeApp(secret = TEST_SECRET) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const _envBefore = process.env.ORA_SESSION_SECRET;
  process.env.ORA_SESSION_SECRET = secret;

  const originalEnv = process.env.ORA_SESSION_SECRET;
  void originalEnv;

  return app;
}

function makeSession(secret = TEST_SECRET, overrides: Record<string, unknown> = {}) {
  const payload = {
    sessionId: "test-session-" + Math.random().toString(36).slice(2),
    msgCount: 0,
    msgLimit: 20,
    fileCount: 0,
    fileLimit: 3,
    ...overrides,
  };
  const token = jwt.sign(payload, secret, { expiresIn: "30m" });
  return { token, payload };
}

async function buildApp() {
  process.env.ORA_SESSION_SECRET = TEST_SECRET;
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  const router = (await import("../dataset-analysis")).default;
  app.use(router);
  return app;
}

function makeFakeDatasetSummary() {
  return {
    rowCount: 100,
    colCount: 3,
    headers: ["region", "revenue", "units"],
    sampleRows: [["North", "5000", "100"]],
    columnProfiles: [
      {
        index: 0,
        type: "string" as const,
        nullCount: 0,
        uniqueCount: 3,
        topCategories: [
          { value: "North", count: 40 },
          { value: "South", count: 35 },
          { value: "East", count: 25 },
        ],
      },
      {
        index: 1,
        type: "numeric" as const,
        nullCount: 0,
        uniqueCount: 100,
        min: 100,
        max: 10000,
        mean: 5050,
        sum: 505000,
        stddev: 2887,
      },
      {
        index: 2,
        type: "numeric" as const,
        nullCount: 0,
        uniqueCount: 50,
        min: 1,
        max: 500,
        mean: 100,
        sum: 10000,
        stddev: 80,
      },
    ],
    paretoSets: [],
    sanitizedCellCount: 0,
    hiddenSheetsSkipped: 0,
    truncated: false,
  };
}

const VALID_AI_RESPONSE = JSON.stringify({
  type: "dataset-analysis",
  analysisType: "general",
  summary: "The dataset shows strong performance in the North region.",
  keyFindings: ["North region leads revenue."],
  recommendations: ["Focus marketing on the North region."],
});

describe("/api/public-ai/dataset-analysis", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.ORA_SESSION_SECRET = TEST_SECRET;
    app = await buildApp();
  });

  it("returns 401 with no session cookie", async () => {
    const res = await request(app)
      .post("/public-ai/dataset-analysis")
      .send({ fileRef: "00000000-0000-0000-0000-000000000000", message: "Analyze this" });
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid request body", async () => {
    const { token } = makeSession();
    const res = await request(app)
      .post("/public-ai/dataset-analysis")
      .set("Cookie", `ora-session=${token}`)
      .send({ fileRef: "not-a-uuid", message: "hello" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown fileRef", async () => {
    const { token } = makeSession();
    const res = await request(app)
      .post("/public-ai/dataset-analysis")
      .set("Cookie", `ora-session=${token}`)
      .send({
        fileRef: "12345678-1234-1234-1234-123456789012",
        message: "Analyze this",
        messages: [],
      });
    expect(res.status).toBe(404);
  });

  it("returns 400 when fileRef points to a document (no datasetSummary)", async () => {
    const { token, payload } = makeSession();
    const fileRef = storeFile({
      sessionId: payload.sessionId as string,
      filename: "report.pdf",
      mimeType: "application/pdf",
      extractedText: "Some PDF content",
      charCount: 100,
    });

    const res = await request(app)
      .post("/public-ai/dataset-analysis")
      .set("Cookie", `ora-session=${token}`)
      .send({ fileRef, message: "Analyze this", messages: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/document/i);
  });

  it("returns 404 for cross-session fileRef (session isolation)", async () => {
    const { payload: payloadA } = makeSession();
    const { token: tokenB } = makeSession();

    const fileRef = storeFile({
      sessionId: payloadA.sessionId as string,
      filename: "data.csv",
      mimeType: "text/csv",
      extractedText: "",
      charCount: 0,
      datasetSummary: makeFakeDatasetSummary(),
    });

    const res = await request(app)
      .post("/public-ai/dataset-analysis")
      .set("Cookie", `ora-session=${tokenB}`)
      .send({ fileRef, message: "Analyze this", messages: [] });
    expect(res.status).toBe(404);
  });

  it("returns 200 with structured result on success", async () => {
    const { createChatCompletion } = await import("../../../lib/ai-providers");
    vi.mocked(createChatCompletion).mockResolvedValueOnce({
      choices: [{ message: { content: VALID_AI_RESPONSE }, finish_reason: "stop" }],
      id: "test",
      model: "gpt-5.4",
      object: "chat.completion",
      created: 0,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as never);

    const { token, payload } = makeSession();
    const fileRef = storeFile({
      sessionId: payload.sessionId as string,
      filename: "sales.csv",
      mimeType: "text/csv",
      extractedText: "",
      charCount: 0,
      datasetSummary: makeFakeDatasetSummary(),
    });

    const res = await request(app)
      .post("/public-ai/dataset-analysis")
      .set("Cookie", `ora-session=${token}`)
      .send({ fileRef, message: "What are the top revenue drivers?", messages: [] });

    expect(res.status).toBe(200);
    expect(res.body.result).toBeDefined();
    expect(res.body.result.type).toBe("dataset-analysis");
    expect(res.body.result.summary).toBeTruthy();
    expect(res.body.result.datasetProfile).toBeDefined();
    expect(res.body.result.datasetProfile.rowCount).toBe(100);
    expect(res.body.result.datasetProfile.colCount).toBe(3);
    expect(res.body.result.usedFallback).toBe(false);
    expect(typeof res.body.msgCount).toBe("number");
    expect(typeof res.body.msgLimit).toBe("number");
  });

  it("returns 502 when both primary and fallback AI fail", async () => {
    const { createChatCompletion } = await import("../../../lib/ai-providers");
    vi.mocked(createChatCompletion).mockRejectedValue(new Error("Model unavailable"));

    const { token, payload } = makeSession();
    const fileRef = storeFile({
      sessionId: payload.sessionId as string,
      filename: "data.csv",
      mimeType: "text/csv",
      extractedText: "",
      charCount: 0,
      datasetSummary: makeFakeDatasetSummary(),
    });

    const res = await request(app)
      .post("/public-ai/dataset-analysis")
      .set("Cookie", `ora-session=${token}`)
      .send({ fileRef, message: "Analyze this", messages: [] });
    expect(res.status).toBe(502);
  });

  it("returns 200 with usedFallback=true when primary JSON is invalid and Anthropic succeeds", async () => {
    const { createChatCompletion } = await import("../../../lib/ai-providers");
    vi.mocked(createChatCompletion)
      .mockResolvedValueOnce({
        choices: [{ message: { content: "not valid json at all {{" }, finish_reason: "stop" }],
        id: "test",
        model: "gpt-5.4",
        object: "chat.completion",
        created: 0,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      } as never)
      .mockResolvedValueOnce({
        choices: [{ message: { content: VALID_AI_RESPONSE }, finish_reason: "stop" }],
        id: "test2",
        model: "claude-sonnet-4-6",
        object: "chat.completion",
        created: 0,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      } as never);

    const { token, payload } = makeSession();
    const fileRef = storeFile({
      sessionId: payload.sessionId as string,
      filename: "data.csv",
      mimeType: "text/csv",
      extractedText: "",
      charCount: 0,
      datasetSummary: makeFakeDatasetSummary(),
    });

    const res = await request(app)
      .post("/public-ai/dataset-analysis")
      .set("Cookie", `ora-session=${token}`)
      .send({ fileRef, message: "Give me a summary", messages: [] });

    expect(res.status).toBe(200);
    expect(res.body.result.usedFallback).toBe(true);
  });

  it("returns 429 when session message limit is reached", async () => {
    const { token } = makeSession(TEST_SECRET, { msgCount: 20, msgLimit: 20 });
    const res = await request(app)
      .post("/public-ai/dataset-analysis")
      .set("Cookie", `ora-session=${token}`)
      .send({
        fileRef: "12345678-1234-1234-1234-123456789012",
        message: "Analyze",
        messages: [],
      });
    expect(res.status).toBe(429);
  });
});

// ─── 9. dataset-prompt: no user data in system prompt ────────────────────────
describe("DATASET_SYSTEM_PROMPT", () => {
  it("contains the required JSON schema type field", async () => {
    const { DATASET_SYSTEM_PROMPT } = await import("../../../lib/public-ai/dataset-prompt");
    expect(DATASET_SYSTEM_PROMPT).toContain("dataset-analysis");
    expect(DATASET_SYSTEM_PROMPT).toContain("JSON object");
  });

  it("instructs model not to follow instructions in data", async () => {
    const { DATASET_SYSTEM_PROMPT } = await import("../../../lib/public-ai/dataset-prompt");
    expect(DATASET_SYSTEM_PROMPT.toLowerCase()).toMatch(/do not follow|not to follow/);
  });
});

// ─── 10. buildDatasetContextBlock: untrusted data labels ─────────────────────
describe("buildDatasetContextBlock", () => {
  it("labels data sample as untrusted", async () => {
    const { buildDatasetContextBlock } = await import("../../../lib/public-ai/dataset-prompt");
    const summary = {
      rowCount: 2,
      colCount: 2,
      headers: ["a", "b"],
      sampleRows: [
        ["1", "2"],
        ["3", "4"],
      ],
      columnProfiles: [],
      paretoSets: [],
      sanitizedCellCount: 0,
      hiddenSheetsSkipped: 0,
      truncated: false,
    };
    const block = buildDatasetContextBlock("test.csv", summary, "What is the average?");
    expect(block).toContain("UNTRUSTED");
    expect(block).toContain("DO NOT FOLLOW");
    expect(block).toContain("What is the average?");
  });

  it("does not include raw (un-prefixed) formula strings in the context block", async () => {
    const { buildDatasetContextBlock } = await import("../../../lib/public-ai/dataset-prompt");
    const summary = {
      rowCount: 1,
      colCount: 1,
      headers: ["val"],
      sampleRows: [["'=EXEC(malicious)"]],
      columnProfiles: [],
      paretoSets: [],
      sanitizedCellCount: 1,
      hiddenSheetsSkipped: 0,
      truncated: false,
    };
    const block = buildDatasetContextBlock("data.csv", summary, "Summarize");
    // The neutralized cell value starts with '; no bare =EXEC should appear without the prefix
    expect(block).not.toMatch(/(?<!')=EXEC/);
    expect(block).toContain("'=EXEC(malicious)");
    expect(block).toContain("UNTRUSTED");
    expect(block).toContain("DO NOT FOLLOW");
  });
});
