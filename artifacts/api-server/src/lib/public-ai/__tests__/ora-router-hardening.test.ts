import { describe, expect, it } from "vitest";
import { resolveFinalOraRoute } from "../route-resolution";
import type { OraRouteDecision } from "../orchestrator";

/**
 * Phase 3 — Smarter Router Hardening regression suite.
 *
 * `resolveFinalOraRoute` is the single deterministic precedence resolver
 * shared by /public-ai/chat and /public-ai/chat/stream. These tests exercise
 * the REAL pattern helpers (no mocks) so the precedence rules are verified
 * against actual classifier behavior:
 *
 *   1. forceSearch is TERMINAL (user-forced retry can never be re-routed).
 *   2. Uploaded-file edits beat chat/incidental-image/incidental-search hits,
 *      UNLESS (a) the user explicitly asked for image generation, (b) the
 *      message explicitly asks for current/live info, or (c) the newest
 *      carried file is a ZIP/archive and there is no explicit export ask.
 *   3. Otherwise the orchestrator decision stands unchanged.
 */

function decision(
  tool: OraRouteDecision["tool"],
  extra?: Partial<OraRouteDecision>,
): OraRouteDecision {
  return {
    tool,
    reason: "test-orchestrator-decision",
    intent: "premium",
    confidence: "high",
    topic: "general",
    ...extra,
  };
}

// Carried-docs blocks list the NEWEST file first (mirrors carried-docs.ts).
const WORD_DOCS = "File: quarterly-report.docx\nContent:\nQ3 revenue summary and highlights.";
const ZIP_DOCS = "File: project.zip\nContent:\nsrc/index.ts, package.json, README.md";
const ZIP_NEWEST_OVER_WORD =
  "File: project.zip\nContent:\nsrc/index.ts\n\nFile: quarterly-report.docx\nContent:\nQ3 summary.";

describe("Phase 3 router hardening — forceSearch is terminal", () => {
  it(
    "pins a non-search decision to search even with carried docs + edit phrasing",
    { timeout: 30000 },
    () => {
      const res = resolveFinalOraRoute({
        decision: decision("answer"),
        message: "make this more professional",
        carriedDocs: WORD_DOCS,
        forceSearch: true,
      });
      expect(res.decision.tool).toBe("search");
      expect(res.decision.reason).toContain("user-forced live search retry");
      expect(res.conflictResolution).toBe("force_search_pin");
      expect(res.inferredFileFormat).toBeNull();
    },
  );

  it("keeps an already-search decision unchanged but still reports the pin", () => {
    const searchDecision = decision("search");
    const res = resolveFinalOraRoute({
      decision: searchDecision,
      message: "what happened in the match today?",
      carriedDocs: "",
      forceSearch: true,
    });
    expect(res.decision).toBe(searchDecision);
    expect(res.conflictResolution).toBe("force_search_pin");
  });
});

describe("Phase 3 router hardening — uploaded-file edit precedence", () => {
  it("routes a Word-doc edit request to file_generation docx (edit_over_chat)", () => {
    const res = resolveFinalOraRoute({
      decision: decision("answer"),
      message: "make this more professional",
      carriedDocs: WORD_DOCS,
    });
    expect(res.decision.tool).toBe("file_generation");
    expect(res.decision.fileFormat).toBe("docx");
    expect(res.decision.reason).toContain("uploaded file modification routed to docx");
    expect(res.conflictResolution).toBe("edit_over_chat");
    expect(res.inferredFileFormat).toBe("docx");
  });

  it("edit beats an incidental search-pattern hit when nothing asks for live info", () => {
    const res = resolveFinalOraRoute({
      decision: decision("search"),
      message: "rewrite it with better wording",
      carriedDocs: WORD_DOCS,
    });
    expect(res.decision.tool).toBe("file_generation");
    expect(res.decision.fileFormat).toBe("docx");
    expect(res.conflictResolution).toBe("edit_over_search");
  });

  it("keeps a file_generation decision as-is when it already carries a format", () => {
    const already = decision("file_generation", { fileFormat: "docx" });
    const res = resolveFinalOraRoute({
      decision: already,
      message: "add a section about pricing",
      carriedDocs: WORD_DOCS,
    });
    expect(res.decision).toBe(already);
    expect(res.conflictResolution).toBeNull();
    expect(res.inferredFileFormat).toBe("docx");
  });
});

describe("Phase 3 router hardening — explicit image asks are never hijacked", () => {
  it('keeps image generation for "create a logo with the word Ora on it" despite carried docs', () => {
    // "word" trips the docx pattern and the edit inference, but the explicit
    // image ask must win: users reported logo prompts silently becoming files.
    const imgDecision = decision("image_generation");
    const res = resolveFinalOraRoute({
      decision: imgDecision,
      message: "create a logo with the word Ora on it",
      carriedDocs: WORD_DOCS,
    });
    expect(res.decision).toBe(imgDecision);
    expect(res.decision.tool).toBe("image_generation");
    expect(res.conflictResolution).toBe("explicit_image_over_edit");
    expect(res.inferredFileFormat).toBeNull();
  });

  it("an explicit image ask that is not edit-phrased passes through untouched", () => {
    const imgDecision = decision("image_generation");
    const res = resolveFinalOraRoute({
      decision: imgDecision,
      message: "generate an image of the World Cup 2026 trophy",
      carriedDocs: WORD_DOCS,
    });
    expect(res.decision).toBe(imgDecision);
    expect(res.conflictResolution).toBeNull();
  });

  it('"just say the word" with carried docs stays a plain chat answer', () => {
    // "word" alone must never trigger the file editor — the bare-noun gate is
    // forbidden; only edit-verb phrasing enters the precedence rules.
    const chatDecision = decision("answer");
    const res = resolveFinalOraRoute({
      decision: chatDecision,
      message: "just say the word",
      carriedDocs: WORD_DOCS,
    });
    expect(res.decision).toBe(chatDecision);
    expect(res.decision.tool).toBe("answer");
    expect(res.conflictResolution).toBeNull();
    expect(res.inferredFileFormat).toBeNull();
  });

  it('"what is image generation?" without docs passes through unchanged', () => {
    const chatDecision = decision("answer");
    const res = resolveFinalOraRoute({
      decision: chatDecision,
      message: "what is image generation?",
      carriedDocs: "",
    });
    expect(res.decision).toBe(chatDecision);
    expect(res.conflictResolution).toBeNull();
  });
});

describe("Phase 3 router hardening — explicit current/live info keeps search", () => {
  it("a latest-scores update request with carried docs stays on the search tool", () => {
    const searchDecision = decision("search");
    const res = resolveFinalOraRoute({
      decision: searchDecision,
      message: "update it with the latest 2026 World Cup scores",
      carriedDocs: WORD_DOCS,
    });
    expect(res.decision).toBe(searchDecision);
    expect(res.decision.tool).toBe("search");
    expect(res.conflictResolution).toBe("search_over_edit_current_info");
    expect(res.inferredFileFormat).toBeNull();
  });
});

describe("Phase 3 router hardening — ZIP/archive analysis guard", () => {
  it("archive follow-up edits stay analysis without an explicit export ask", () => {
    const chatDecision = decision("answer");
    const res = resolveFinalOraRoute({
      decision: chatDecision,
      message: "make this more professional",
      carriedDocs: ZIP_DOCS,
    });
    expect(res.decision).toBe(chatDecision);
    expect(res.decision.tool).toBe("answer");
    expect(res.conflictResolution).toBe("zip_analysis_guard");
    expect(res.inferredFileFormat).toBeNull();
  });

  it("the guard keys on the NEWEST carried file, not any archive anywhere", () => {
    const res = resolveFinalOraRoute({
      decision: decision("answer"),
      message: "make this more professional",
      carriedDocs: ZIP_NEWEST_OVER_WORD,
    });
    expect(res.decision.tool).toBe("answer");
    expect(res.conflictResolution).toBe("zip_analysis_guard");
  });

  it("an explicit export ask overrides the archive guard and routes to the file", () => {
    const res = resolveFinalOraRoute({
      decision: decision("answer"),
      message: "export a summary of this archive as a PDF",
      carriedDocs: ZIP_DOCS,
    });
    expect(res.decision.tool).toBe("file_generation");
    expect(res.decision.fileFormat).toBe("pdf");
    expect(res.conflictResolution).toBe("edit_over_chat");
    expect(res.inferredFileFormat).toBe("pdf");
  });
});
