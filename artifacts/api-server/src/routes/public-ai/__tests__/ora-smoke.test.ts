/**
 * Ora smoke test & wiring audit.
 *
 * This file is a comprehensive integration-style sanity check across all Ora
 * surfaces. It uses only pure-function tests and source-code structural
 * assertions — no DB, no network, no mocked providers (unless needed for
 * isolation). Each describe block maps to one numbered audit surface.
 *
 * Surfaces covered:
 *  a) Chat reply shape — routeOraMessage produces a well-formed decision
 *  b) Model-router tool selection — correct tool per intent
 *  c) Memory consolidation — shouldSupersede + findMemoriesToSupersede logic
 *  d) File-gen intent — detectFileRequest + routeOraMessage picks file_generation tool
 *  e) Image intent routing — isImageGenerationRequest + routeOraMessage picks image_generation tool
 *  f) Pasted Codex / tool output stays conversational — isPastedReferenceAnalysisRequest
 *  g) Builder isolation — chat.ts has no builder/jobs imports
 *  h) STT / transcribe — route source structure: session gate, empty-body guard
 *  i) TTS auto-speak — tts.ts uses direct OPENAI_API_KEY, not the proxy
 *  j) Surface isolation — ora-conversations.ts has surface=normal on every per-row CRUD endpoint
 */

import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

// ─── File paths ───────────────────────────────────────────────────────────────

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
const ROUTES_PUBLIC_AI = join(REPO_ROOT, "artifacts", "api-server", "src", "routes", "public-ai");
const API_ROUTES = join(REPO_ROOT, "artifacts", "api-server", "src", "routes");

function readRoute(filename: string): string {
  return readFileSync(join(ROUTES_PUBLIC_AI, filename), "utf-8");
}

function readApiRoute(filename: string): string {
  return readFileSync(join(API_ROUTES, filename), "utf-8");
}

// ─── Pure imports (no DB / network) ──────────────────────────────────────────

import {
  routeOraMessage,
  isImageGenerationRequest,
  isImageSearchRequest,
  isWebSearchRequest,
  checkToolAccess,
  ORA_TOOL_REGISTRY,
  ORA_IMAGE_PATTERNS,
  ORA_SEARCH_PATTERNS,
} from "../../../lib/public-ai/orchestrator";

import {
  detectFileRequest,
  isPastedReferenceAnalysisRequest,
} from "../../../lib/public-ai/prompt";

import {
  shouldSupersede,
  findMemoriesToSupersede,
  tokenizeMemory,
} from "../../../lib/public-ai/memory-consolidation";

// Pre-computed classifier stub so routeOraMessage never makes a live LLM call.
const STUB_CLASSIFIER = {
  intent: "premium" as const,
  confidence: "high" as const,
  topic: "general" as const,
};

// ─── a) Chat reply shape ──────────────────────────────────────────────────────

describe("a) Chat reply shape — routeOraMessage", () => {
  it("returns a decision object with required fields for a plain question", async () => {
    const result = await routeOraMessage({
      message: "What is the capital of France?",
      mode: "instant",
      classifier: STUB_CLASSIFIER,
    });
    expect(result).toHaveProperty("tool");
    expect(result).toHaveProperty("intent");
    expect(result).toHaveProperty("confidence");
    expect(typeof result.tool).toBe("string");
  });

  it("decision.tool is one of the registered OraTool types", async () => {
    const knownTools = Object.keys(ORA_TOOL_REGISTRY);
    const result = await routeOraMessage({
      message: "Explain how closures work in JavaScript",
      mode: "instant",
      classifier: STUB_CLASSIFIER,
    });
    expect(knownTools).toContain(result.tool);
  });

  it("plain question in instant mode returns 'answer' tool", async () => {
    const result = await routeOraMessage({
      message: "What is the capital of France?",
      mode: "instant",
      classifier: STUB_CLASSIFIER,
    });
    expect(result.tool).toBe("answer");
  });

  it("image-gen message => tool is 'image_generation'", async () => {
    const result = await routeOraMessage({
      message: "generate a logo for my bakery",
      mode: "instant",
      classifier: STUB_CLASSIFIER,
    });
    expect(result.tool).toBe("image_generation");
  });

  it("search message => tool is 'search'", async () => {
    const result = await routeOraMessage({
      message: "what's the latest news today",
      mode: "instant",
      classifier: STUB_CLASSIFIER,
    });
    expect(result.tool).toBe("search");
  });

  it("file request => tool is 'file_generation'", async () => {
    const result = await routeOraMessage({
      message: "give me a CSV of the top 10 countries",
      mode: "instant",
      classifier: STUB_CLASSIFIER,
    });
    expect(result.tool).toBe("file_generation");
  });
});

// ─── b) Model-router tool selection ──────────────────────────────────────────

describe("b) Model-router tool selection — ORA_TOOL_REGISTRY", () => {
  it("all registry entries have required fields (tool, description, minAccess, creditCost, status)", () => {
    for (const [key, meta] of Object.entries(ORA_TOOL_REGISTRY)) {
      expect(meta, `${key}.tool`).toHaveProperty("tool");
      expect(meta, `${key}.description`).toHaveProperty("description");
      expect(meta, `${key}.minAccess`).toHaveProperty("minAccess");
      expect(meta, `${key}.creditCost`).toHaveProperty("creditCost");
      expect(meta, `${key}.status`).toHaveProperty("status");
      expect(["live", "planned"]).toContain(meta.status);
      expect(["anon", "free", "paid"]).toContain(meta.minAccess);
    }
  });

  it("image_editing tool is registered as live (not planned)", () => {
    expect(ORA_TOOL_REGISTRY.image_editing.status).toBe("live");
  });

  it("answer tool is anon-accessible (no sign-in required)", () => {
    expect(ORA_TOOL_REGISTRY.answer.minAccess).toBe("anon");
  });

  it("search tool requires at least free (signed-in) access", () => {
    expect(["free", "paid"]).toContain(ORA_TOOL_REGISTRY.search.minAccess);
  });

  it("deep_thinking tool requires paid access", () => {
    expect(ORA_TOOL_REGISTRY.deep_thinking.minAccess).toBe("paid");
  });

  it("checkToolAccess denies search to anonymous visitors", () => {
    const result = checkToolAccess("search", {
      authed: false,
      isPaid: false,
    });
    expect(result.allowed).toBe(false);
    expect(result.denyCode).toBe("search_signin_required");
  });

  it("checkToolAccess allows search for signed-in (authed) users", () => {
    const result = checkToolAccess("search", {
      authed: true,
      isPaid: false,
    });
    expect(result.allowed).toBe(true);
  });

  it("checkToolAccess blocks deep_thinking for free (authed but not paid) users", () => {
    const result = checkToolAccess("deep_thinking", {
      authed: true,
      isPaid: false,
    });
    expect(result.allowed).toBe(false);
    expect(result.denyCode).toBe("deep_paid_only");
  });

  it("checkToolAccess allows deep_thinking for paid users", () => {
    const result = checkToolAccess("deep_thinking", {
      authed: true,
      isPaid: true,
    });
    expect(result.allowed).toBe(true);
  });

  it("checkToolAccess allows answer (conversational) for unauthenticated visitors", () => {
    const result = checkToolAccess("answer", {
      authed: false,
      isPaid: false,
    });
    expect(result.allowed).toBe(true);
  });
});

// ─── c) Memory consolidation ─────────────────────────────────────────────────

describe("c) Memory consolidation — shouldSupersede + findMemoriesToSupersede", () => {
  it("supersedes a contradicting preference (dark → light mode)", () => {
    expect(
      shouldSupersede(
        { title: "Display preference", content: "I prefer light mode" },
        { title: "Display preference", content: "I prefer dark mode" },
      ),
    ).toBe(true);
  });

  it("supersedes a contradicting budget fact", () => {
    expect(
      shouldSupersede(
        { title: "Budget", content: "my budget is 8000 dollars" },
        { title: "Budget", content: "my budget is 5000 dollars" },
      ),
    ).toBe(true);
  });

  it("does NOT supersede a distinct 'I like coffee' vs 'I like tea' pair", () => {
    expect(
      shouldSupersede(
        { title: "Drinks", content: "I like tea" },
        { title: "Drinks", content: "I like coffee" },
      ),
    ).toBe(false);
  });

  it("does NOT supersede when both memories have fewer than 2 significant tokens", () => {
    expect(
      shouldSupersede(
        { title: "Hi", content: "ok" },
        { title: "Hello", content: "yes" },
      ),
    ).toBe(false);
  });

  it("tokenizeMemory strips stopwords and normalises plurals", () => {
    const tokens = tokenizeMemory("I like dollars and euros");
    expect(tokens.has("dollar")).toBe(true);
    expect(tokens.has("euro")).toBe(true);
    expect(tokens.has("like")).toBe(false);
    expect(tokens.has("and")).toBe(false);
    expect(tokens.has("i")).toBe(false);
  });

  it("tokenizeMemory drops tokens shorter than 3 characters", () => {
    const tokens = tokenizeMemory("go to the it");
    expect(tokens.has("go")).toBe(false);
    expect(tokens.has("it")).toBe(false);
  });

  it("findMemoriesToSupersede returns ids of overlapping existing memories", () => {
    const incoming = { title: "Theme", content: "I prefer light mode" };
    const existing = [
      { id: 1, title: "Theme", content: "I prefer dark mode" },
      { id: 2, title: "Drinks", content: "I like coffee" },
    ];
    const ids = findMemoriesToSupersede(incoming, existing);
    expect(ids).toContain(1);
    expect(ids).not.toContain(2);
  });

  it("findMemoriesToSupersede returns empty array when no overlap", () => {
    const incoming = { title: "Language", content: "I write Python code" };
    const existing = [{ id: 10, title: "Food", content: "I eat sushi for dinner" }];
    const ids = findMemoriesToSupersede(incoming, existing);
    expect(ids).toHaveLength(0);
  });

  it("supersedes same attribute slot (name)", () => {
    expect(
      shouldSupersede(
        { title: "Name", content: "My name is Alice" },
        { title: "Name", content: "My name is Bob" },
      ),
    ).toBe(true);
  });

  it("supersedes same attribute slot (location)", () => {
    expect(
      shouldSupersede(
        { title: "Location", content: "I live in Paris" },
        { title: "Location", content: "I live in London" },
      ),
    ).toBe(true);
  });
});

// ─── d) File-gen intent detection ────────────────────────────────────────────

describe("d) File-gen intent — detectFileRequest + routeOraMessage", () => {
  it("detectFileRequest detects CSV format", () => {
    expect(detectFileRequest("give me a CSV of my data")).toBe("csv");
  });

  it("detectFileRequest detects PDF format", () => {
    expect(detectFileRequest("create a PDF report for me")).toBe("pdf");
  });

  it("detectFileRequest detects Excel/xlsx format", () => {
    expect(detectFileRequest("export to Excel spreadsheet")).toBe("xlsx");
  });

  it("detectFileRequest detects Word/docx format", () => {
    expect(detectFileRequest("write a word document summarizing the project")).toBe("docx");
  });

  it("detectFileRequest detects PowerPoint/pptx format", () => {
    expect(detectFileRequest("create a presentation for the client")).toBe("pptx");
  });

  it("detectFileRequest returns null for plain chat", () => {
    expect(detectFileRequest("explain how closures work")).toBeNull();
  });

  it("detectFileRequest returns null for pasted tool report (file keywords present but it's a reference)", () => {
    const pastedReport = `Replit quality-gate results:
format: PASSED
lint: PASSED
typecheck: PASSED
codegen-drift: PASSED
What do these results mean?`;
    expect(detectFileRequest(pastedReport)).toBeNull();
  });

  it("routeOraMessage picks 'file_generation' tool for CSV request", async () => {
    const result = await routeOraMessage({
      message: "generate a CSV of top 10 countries by population",
      mode: "instant",
      classifier: STUB_CLASSIFIER,
    });
    expect(result.tool).toBe("file_generation");
  });

  it("routeOraMessage picks 'file_generation' tool for PDF request", async () => {
    const result = await routeOraMessage({
      message: "create a PDF report summarizing the quarterly results",
      mode: "instant",
      classifier: STUB_CLASSIFIER,
    });
    expect(result.tool).toBe("file_generation");
  });
});

// ─── e) Image intent routing ──────────────────────────────────────────────────

describe("e) Image intent routing — isImageGenerationRequest + routeOraMessage", () => {
  it("isImageGenerationRequest matches explicit generation verbs", () => {
    expect(isImageGenerationRequest("generate a logo for my company")).toBe(true);
    expect(isImageGenerationRequest("create an illustration of a sunset")).toBe(true);
    expect(isImageGenerationRequest("draw a cartoon cat")).toBe(true);
    expect(isImageGenerationRequest("design a banner for my website")).toBe(true);
  });

  it("isImageGenerationRequest matches 'make/paint/sketch' verbs", () => {
    expect(isImageGenerationRequest("make a portrait of a knight")).toBe(true);
    expect(isImageGenerationRequest("paint a watercolor landscape")).toBe(true);
  });

  it("isImageGenerationRequest does NOT match blocklisted creative writing", () => {
    expect(isImageGenerationRequest("describe a character profile for my story")).toBe(false);
    expect(isImageGenerationRequest("background on the history of Rome")).toBe(false);
  });

  it("isImageSearchRequest matches retrieval requests with required qualifier", () => {
    expect(isImageSearchRequest("find images of sunsets online")).toBe(true);
    expect(isImageSearchRequest("find the official logo for Tesla")).toBe(true);
  });

  it("isImageSearchRequest requires an explicit search/find verb (not 'show me <noun>')", () => {
    expect(isImageSearchRequest("show me pictures of the Eiffel Tower")).toBe(false);
  });

  it("isImageSearchRequest does NOT match creation verbs", () => {
    expect(isImageSearchRequest("generate a logo for my bakery")).toBe(false);
    expect(isImageSearchRequest("create an illustration of a cat")).toBe(false);
  });

  it("ORA_IMAGE_PATTERNS covers at least 5 distinct patterns", () => {
    expect(ORA_IMAGE_PATTERNS.length).toBeGreaterThanOrEqual(5);
  });

  it("routeOraMessage picks 'image_generation' tool for a generation request", async () => {
    const result = await routeOraMessage({
      message: "generate an illustration of a rocket ship landing on Mars",
      mode: "instant",
      classifier: STUB_CLASSIFIER,
    });
    expect(result.tool).toBe("image_generation");
  });

  it("routeOraMessage picks 'image_generation' for draw/paint/sketch requests", async () => {
    const result = await routeOraMessage({
      message: "draw a minimalist logo for a coffee shop",
      mode: "instant",
      classifier: STUB_CLASSIFIER,
    });
    expect(result.tool).toBe("image_generation");
  });
});

// ─── f) Pasted Codex / tool output stays conversational ──────────────────────

describe("f) Pasted tool output — isPastedReferenceAnalysisRequest", () => {
  const CODEX_PASTE = `Replit quality-gate workflow:
lint: PASSED
format: PASSED
typecheck: FAILED
codegen-drift: PASSED
What should I tell Replit about the typecheck failure?`;

  const LONG_GITHUB_PASTE = `Replit pull-from-github workflow:
Fetching from GitHub MustaFlow-AI1 (forced ref update)
error: cannot lock ref refs/remotes/github/main: is at abc1234
From https://github.com/example/repo
 ! 632704e1..a2b89ebc  main -> github/main (unable to update local ref)
typecheck: FAILED
lint: PASSED
What does this git conflict mean and how should I fix it?`;

  it("identifies a pasted Replit workflow report", () => {
    expect(isPastedReferenceAnalysisRequest(CODEX_PASTE)).toBe(true);
  });

  it("identifies a pasted GitHub/Replit error output with enough signal", () => {
    expect(isPastedReferenceAnalysisRequest(LONG_GITHUB_PASTE)).toBe(true);
  });

  it("does NOT misidentify a plain short question as a paste", () => {
    expect(isPastedReferenceAnalysisRequest("how do I build a todo app?")).toBe(false);
  });

  it("does NOT misidentify a blank string as a paste", () => {
    expect(isPastedReferenceAnalysisRequest("")).toBe(false);
  });

  it("does NOT misidentify a normal conversational message as a paste", () => {
    expect(isPastedReferenceAnalysisRequest("I want to plan a marketing campaign")).toBe(false);
  });

  it("routeOraMessage routes pasted Replit report to conversational tool, not file_generation", async () => {
    const result = await routeOraMessage({
      message: CODEX_PASTE,
      mode: "instant",
      classifier: STUB_CLASSIFIER,
    });
    expect(result.tool).not.toBe("file_generation");
  });

  it("ORA_SEARCH_PATTERNS covers live-info queries", () => {
    expect(ORA_SEARCH_PATTERNS.some((p) => p.test("what's the latest news today"))).toBe(true);
    expect(ORA_SEARCH_PATTERNS.some((p) => p.test("current bitcoin price"))).toBe(true);
  });

  it("isWebSearchRequest correctly identifies current-info questions", () => {
    expect(isWebSearchRequest("what's the latest news on the election")).toBe(true);
    expect(isWebSearchRequest("what is the current bitcoin price")).toBe(true);
    expect(isWebSearchRequest("who won the game today")).toBe(true);
  });

  it("isWebSearchRequest does NOT hijack ordinary conversational questions", () => {
    expect(isWebSearchRequest("how do I build a todo app with MustaFlow?")).toBe(false);
    expect(isWebSearchRequest("explain how closures work in JavaScript")).toBe(false);
  });
});

// ─── g) Builder isolation ─────────────────────────────────────────────────────

describe("g) Builder isolation — chat.ts has no builder/jobs imports", () => {
  const chatSrc = readRoute("chat.ts");

  it("chat.ts does not import from builder.ts", () => {
    expect(chatSrc).not.toMatch(/from\s+['"].*\/builder['"]/);
    expect(chatSrc).not.toMatch(/require\(['"].*\/builder['"]\)/);
  });

  it("chat.ts does not import from jobs.ts", () => {
    expect(chatSrc).not.toMatch(/from\s+['"].*\/jobs['"]/);
    expect(chatSrc).not.toMatch(/require\(['"].*\/jobs['"]\)/);
  });

  it("chat.ts does not import from the builder AI layer (lib/ai)", () => {
    expect(chatSrc).not.toMatch(/from\s+['"].*\/lib\/ai['"]/);
  });

  it("Ora memory context reads only scope='user' AND origin='ora' entries (not project knowledge)", () => {
    expect(chatSrc).toMatch(/scope.*user/);
    expect(chatSrc).toMatch(/origin.*ora/);
  });

  it("Ora web-search personalContext is assembled from profile + saved memories", () => {
    expect(chatSrc).toContain("searchProfileContext");
    expect(chatSrc).toContain("searchMemory");
    expect(chatSrc).toContain("searchPersonalContext");
  });

  it("chat.ts does not reference Builder credits (credit system is separate)", () => {
    expect(chatSrc).not.toMatch(/deductCredit|chargeCredit|spendCredit/);
  });
});

// ─── h) STT / transcribe route wiring ────────────────────────────────────────

describe("h) STT / transcribe — route session gate and empty-body guard", () => {
  const src = readRoute("transcribe.ts");

  it("transcribe.ts validates the ora-session cookie before processing audio", () => {
    expect(src).toContain("validateSession");
    expect(src).toContain("ora-session");
  });

  it("transcribe.ts returns 401 when session token is absent", () => {
    expect(src).toContain("401");
    expect(src).toContain("No active session");
  });

  it("transcribe.ts guards against already-consumed stream (req.readableEnded)", () => {
    expect(src).toContain("req.readableEnded");
  });

  it("transcribe.ts enforces a max payload size", () => {
    expect(src).toContain("MAX_AUDIO_BYTES");
  });

  it("transcribe.ts accepts format and lang query params", () => {
    expect(src).toContain("req.query.format");
    expect(src).toContain("req.query.lang");
  });

  it("transcribe.ts is rate-limited with a voice transcribe limiter", () => {
    expect(src).toContain("oraVoiceTranscribeLimiter");
  });

  it("transcribe.ts returns 401 when session token is invalid/expired", () => {
    expect(src).toContain("Session expired");
  });
});

// ─── i) TTS — direct OpenAI key, not proxy ───────────────────────────────────

describe("i) TTS auto-speak — tts.ts uses direct OPENAI_API_KEY, not proxy", () => {
  const src = readRoute("tts.ts");

  it("tts.ts constructs an OpenAI client with the direct OPENAI_API_KEY", () => {
    expect(src).toContain("OPENAI_API_KEY");
    expect(src).toContain("apiKey: process.env.OPENAI_API_KEY");
  });

  it("tts.ts does NOT use the AI-integrations proxy base URL for TTS", () => {
    expect(src).not.toContain("AI_INTEGRATIONS_OPENAI_BASE_URL");
  });

  it("tts.ts degrades gracefully (503) when OPENAI_API_KEY is absent", () => {
    expect(src).toContain("503");
  });

  it("tts.ts validates the ora-session cookie before synthesising audio", () => {
    expect(src).toContain("validateSession");
    expect(src).toContain("ora-session");
  });

  it("tts.ts is rate-limited with a voice TTS limiter", () => {
    expect(src).toContain("oraVoiceTtsLimiter");
  });

  it("tts.ts supports an enumerated list of voices", () => {
    expect(src).toContain("OPENAI_TTS_VOICES");
    expect(src).toContain("alloy");
  });

  it("tts.ts comment explains why the proxy is bypassed for TTS", () => {
    expect(src).toContain("INVALID_ENDPOINT");
  });
});

// ─── j) Surface isolation — ora-conversations.ts ─────────────────────────────

describe("j) Surface isolation — ora-conversations.ts filters surface='normal' on all per-row CRUD", () => {
  const src = readApiRoute("ora-conversations.ts");

  it("surface='normal' filter is applied at least 4 times (list, get, update, messages, delete)", () => {
    const matchCount = (src.match(/eq\(oraConversationsTable\.surface,\s*"normal"\)/g) ?? []).length;
    expect(matchCount).toBeGreaterThanOrEqual(4);
  });

  it("conversation list query filters by surface='normal'", () => {
    expect(src).toContain('surface, "normal"');
  });

  it("archived_at is used for soft-delete scope (not deleted_at)", () => {
    expect(src).toContain("archivedAt");
    expect(src).not.toMatch(/deleted_at/i);
  });

  it("ora-conversations.ts does not expose the support surface through normal CRUD", () => {
    expect(src).not.toContain('"support"');
  });

  it("project conversation scoping is present (projectId)", () => {
    expect(src).toContain("projectId");
  });

  it("ora-conversations.ts applies userId ownership check on owned resources", () => {
    expect(src).toContain("userId");
  });
});
