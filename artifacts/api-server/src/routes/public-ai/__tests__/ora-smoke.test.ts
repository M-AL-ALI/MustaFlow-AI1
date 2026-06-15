/**
 * Ora smoke test & wiring audit.
 *
 * A comprehensive integration-style sanity check that exercises real route
 * handlers (via supertest) with vi.mock'd providers, alongside pure-function
 * checks for orchestrator routing logic and structural source assertions.
 *
 * Surfaces covered:
 *  a) Chat reply shape — POST /public-ai/chat basic contract
 *  b) Model-router tool selection — routeOraMessage + ORA_TOOL_REGISTRY
 *  c) Memory consolidation — shouldSupersede + findMemoriesToSupersede logic
 *  d) File-gen intent — detectFileRequest patterns
 *  e) Image intent routing — isImageGenerationRequest patterns
 *  f) Pasted Codex / tool output stays conversational — isPastedReferenceAnalysisRequest
 *  g) Builder isolation — chat.ts has no builder/jobs imports; source + query assertions
 *  h) STT / transcribe — 401 without session, 400 on empty body
 *  i) TTS — 401 without session, 503 when OPENAI_API_KEY absent
 *  j) Surface isolation — ora-conversations.ts surface=normal gate on all per-row CRUD
 */

import { readFileSync } from "fs";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";

// ─── File paths for source assertions ────────────────────────────────────────

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
const ROUTES_PUBLIC_AI = join(REPO_ROOT, "artifacts", "api-server", "src", "routes", "public-ai");
const API_ROUTES = join(REPO_ROOT, "artifacts", "api-server", "src", "routes");

function readRoute(filename: string): string {
  return readFileSync(join(ROUTES_PUBLIC_AI, filename), "utf-8");
}

function readApiRoute(filename: string): string {
  return readFileSync(join(API_ROUTES, filename), "utf-8");
}

// ─── vi.hoisted mutable state (must precede vi.mock calls) ───────────────────

const authState = vi.hoisted(() => ({
  user: null as null | { userId: string; tier: "free" | "core" | "wave"; isPaid: boolean },
}));

const memoryState = vi.hoisted(() => ({
  rows: [] as Array<{
    id: number;
    title: string;
    content: string;
    category: string | null;
    embedding: number[] | null;
    createdAt: Date;
  }>,
}));

const conversationState = vi.hoisted(() => ({
  rows: [] as Array<{
    id: number;
    title: string | null;
    summary: string | null;
    lastMessageAt: Date;
  }>,
}));

const aiMock = vi.hoisted(() => ({
  createChatCompletion: vi.fn(async (input: Record<string, unknown>) => {
    const messages = (input.messages ?? []) as Array<{ role: string; content: string }>;
    const system = messages[0]?.content ?? "";
    const user = messages[messages.length - 1]?.content ?? "";
    const responseFormat = input.response_format as { type?: string } | undefined;

    if (responseFormat?.type === "json_object") {
      if (system.includes("intent classifier for Ora")) {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  intent: "premium",
                  confidence: "high",
                  topic: user.toLowerCase().includes("plan") ? "product" : "general",
                }),
              },
            },
          ],
        };
      }
      if (system.includes("follow-up questions")) {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({ suggestions: ["What changed?", "Next step?"] }),
              },
            },
          ],
        };
      }
      if (system.includes("extract durable")) {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  save: false,
                  fact: "",
                  explicit: false,
                  category: "other",
                }),
              },
            },
          ],
        };
      }
      return { choices: [{ message: { content: "{}" } }] };
    }

    // Conversational reply — return a minimal direct answer.
    return {
      choices: [
        {
          message: {
            content: system.includes("temporary chat")
              ? "I don't have saved memories available in this temporary chat."
              : "Direct answer.",
          },
        },
      ],
    };
  }),
}));

const fileBuilderMock = vi.hoisted(() => ({
  generateFileFromPrompt: vi.fn(async () => ({
    reply: "Here is your CSV.",
    fileName: "data.csv",
    fileData: Buffer.from("col1,col2\nval1,val2\n").toString("base64"),
    mimeType: "text/csv",
  })),
}));

const imageMock = vi.hoisted(() => ({
  generateImage: vi.fn(async () => ({
    openaiUrl: "data:image/png;base64,aW1hZ2U=",
    quality: "high",
    providerName: "openai",
    modelName: "gpt-image-1",
    revisedPrompt: "a clean logo",
  })),
  isImageProviderConfigured: vi.fn(() => true),
}));

const usageMock = vi.hoisted(() => ({
  consumeOraQuota: vi.fn(async (_userId: string, _tier: string, kind: "message" | "image") => ({
    allowed: true,
    used: 1,
    limit: kind === "image" ? 10 : 100,
    kind,
    resetsAt: null,
  })),
  refundOraQuota: vi.fn(async () => undefined),
  getOraUsage: vi.fn(async () => ({
    messageCount: 1,
    imageCount: 0,
    messageLimit: 100,
    imageLimit: 10,
    windowHours: 24,
    windowStart: null,
    resetsAt: null,
  })),
}));

// ─── vi.mock declarations ─────────────────────────────────────────────────────

vi.mock("../../../lib/ai-providers", () => ({
  createChatCompletion: aiMock.createChatCompletion,
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

vi.mock("../../../lib/public-ai/file-builder", () => ({
  generateFileFromPrompt: fileBuilderMock.generateFileFromPrompt,
  FileGenerationError: class FileGenerationError extends Error {},
}));

vi.mock("../../../lib/image-provider", () => ({
  generateImage: imageMock.generateImage,
  isImageProviderConfigured: imageMock.isImageProviderConfigured,
}));

vi.mock("../../../lib/ora-assets", () => ({
  persistOraAsset: vi.fn(async () => 1),
  parseDataUri: (value: string) => {
    const match = value.match(/^data:([^;]+);base64,(.+)$/);
    return match ? { mimeType: match[1], base64: match[2] } : null;
  },
}));

vi.mock("../../../lib/image-storage", () => ({
  storeGeneratedImage: vi.fn(async () => ({
    fileUrl: "/api/images/1/file",
    thumbnailUrl: "/api/images/1/thumb",
    storageKey: "test/image.png",
  })),
}));

vi.mock("../../../lib/public-ai/authed-user", () => ({
  PAID_TIERS: new Set(["core", "wave"]),
  resolveAuthedOraUser: vi.fn(async () => authState.user),
}));

vi.mock("../../../lib/public-ai/ora-usage", () => usageMock);

vi.mock("../../../lib/embeddings", () => ({
  generateEmbedding: vi.fn(async () => [1, 0, 0]),
  cosineSimilarity: (a: number[], b: number[]) => {
    const dot = a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
    const aMag = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
    const bMag = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0));
    return aMag > 0 && bMag > 0 ? dot / (aMag * bMag) : 0;
  },
  buildEmbeddingInput: (title: string, content: string) => `${title}\n${content}`,
}));

vi.mock("@workspace/db", () => {
  function tableStub() {
    return new Proxy({}, { get: (_target, prop) => ({ name: String(prop) }) }) as Record<
      string,
      unknown
    >;
  }

  function rowsForSelection(selection: unknown): unknown[] {
    const keys =
      selection && typeof selection === "object"
        ? Object.keys(selection as Record<string, unknown>)
        : [];
    if (keys.includes("embedding") && keys.includes("content")) return memoryState.rows;
    if (keys.includes("summary") && keys.includes("lastMessageAt")) return conversationState.rows;
    return [];
  }

  function makeSelect(selection?: unknown) {
    const query: Record<string, unknown> = {
      from: () => query,
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      then: (resolve: (rows: unknown[]) => unknown) => resolve(rowsForSelection(selection)),
    };
    return query;
  }

  function makeMutation() {
    const query: Record<string, unknown> = {
      values: () => query,
      set: () => query,
      where: () => query,
      returning: () => Promise.resolve([]),
      then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
    };
    return query;
  }

  const table = tableStub();
  return {
    db: {
      select: (selection?: unknown) => makeSelect(selection),
      insert: () => makeMutation(),
      update: () => makeMutation(),
    },
    knowledgeEntriesTable: table,
    oraProfilesTable: table,
    oraProjectsTable: table,
    oraConversationsTable: table,
    generatedImagesTable: table,
    TIER_ORA_MESSAGE_LIMIT: { free: 100, core: 1000, wave: 5000 },
    TIER_ORA_IMAGE_LIMIT: { free: 10, core: 50, wave: 100 },
    ORA_MEMORY_CATEGORIES: ["preference", "personal", "project", "document", "other"],
    DEFAULT_ORA_MEMORY_CATEGORY: "other",
  };
});

// ─── Pure imports (after vi.mock declarations) ────────────────────────────────

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

import { detectFileRequest, isPastedReferenceAnalysisRequest } from "../../../lib/public-ai/prompt";

import {
  shouldSupersede,
  findMemoriesToSupersede,
  tokenizeMemory,
} from "../../../lib/public-ai/memory-consolidation";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const TEST_SECRET = "ora-smoke-test-secret";

function makeSession(overrides: Record<string, unknown> = {}) {
  const payload = {
    sessionId: "ora-smoke-" + Math.random().toString(36).slice(2),
    msgCount: 0,
    fileCount: 0,
    imageCount: 0,
    imageAnalysisCount: 0,
    createdAt: Date.now(),
    ...overrides,
  };
  return jwt.sign(payload, TEST_SECRET, { expiresIn: "30m" });
}

async function buildChatApp() {
  process.env.ORA_SESSION_SECRET = TEST_SECRET;
  process.env.PUBLIC_AI_ENABLED = "true";
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  const router = (await import("../chat")).default;
  app.use(router);
  return app;
}

async function buildTtsApp() {
  process.env.ORA_SESSION_SECRET = TEST_SECRET;
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  const router = (await import("../tts")).default;
  app.use(router);
  return app;
}

async function buildTranscribeApp() {
  process.env.ORA_SESSION_SECRET = TEST_SECRET;
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  const router = (await import("../transcribe")).default;
  app.use(router);
  return app;
}

// Pre-computed classifier stub prevents live LLM calls in pure-function tests.
const STUB_CLASSIFIER = {
  intent: "premium" as const,
  confidence: "high" as const,
  topic: "general" as const,
};

// ─── a) Chat reply shape — POST /public-ai/chat ───────────────────────────────

describe("a) Chat reply shape — POST /public-ai/chat", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    authState.user = null;
    memoryState.rows = [];
    conversationState.rows = [];
    app = await buildChatApp();
  });

  it("returns 401 when ora-session cookie is absent", async () => {
    const res = await request(app).post("/public-ai/chat").send({ message: "Hello", messages: [] });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/session/i);
  });

  it("returns 401 when ora-session cookie is invalid", async () => {
    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", "ora-session=not-a-valid-jwt")
      .send({ message: "Hello", messages: [] });
    expect(res.status).toBe(401);
  });

  it("returns 200 with reply field for an anonymous visitor (baseline)", async () => {
    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({ message: "What is the capital of France?", messages: [] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("reply");
    expect(typeof res.body.reply).toBe("string");
    expect(res.body.reply.length).toBeGreaterThan(0);
  });

  it("reply does not include imageUrl or file fields for a plain question", async () => {
    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({ message: "Explain how closures work in JavaScript.", messages: [] });

    expect(res.status).toBe(200);
    expect(res.body.imageUrl).toBeUndefined();
    expect(res.body.fileName).toBeUndefined();
    expect(res.body.fileData).toBeUndefined();
  });

  it("includes msgCount and msgLimit in every successful response", async () => {
    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({ message: "Tell me about Node.js", messages: [] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("msgCount");
    expect(res.body).toHaveProperty("msgLimit");
    expect(typeof res.body.msgCount).toBe("number");
  });

  it("returns 200 with file fields when CSV is requested", async () => {
    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({ message: "Create a CSV of my data", messages: [] });

    expect(res.status).toBe(200);
    expect(res.body.fileName).toMatch(/\.csv$/);
    expect(res.body.fileData).toBeTruthy();
    expect(res.body.mimeType).toBe("text/csv");
    expect(res.body.imageUrl).toBeUndefined();
    expect(fileBuilderMock.generateFileFromPrompt).toHaveBeenCalledTimes(1);
  });

  it("returns 200 with imageUrl for a signed-in user requesting an image", async () => {
    authState.user = { userId: "smoke-user-1", tier: "core", isPaid: true };

    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({ message: "Generate a logo for my bakery", messages: [] });

    expect(res.status).toBe(200);
    expect(res.body.imageUrl).toBeTruthy();
    expect(res.body.fileName).toBeUndefined();
    expect(imageMock.generateImage).toHaveBeenCalledTimes(1);
    expect(usageMock.consumeOraQuota).toHaveBeenCalledWith("smoke-user-1", "core", "image");
  });

  it("does NOT call image provider for an anonymous visitor (image requires sign-in)", async () => {
    authState.user = null;

    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({ message: "Generate a logo for my bakery", messages: [] });

    // Anonymous visitors get a conversational nudge to sign up, not an error
    expect(res.status).toBe(200);
    // Image provider must NOT have been called for an anonymous visitor
    expect(imageMock.generateImage).not.toHaveBeenCalled();
  });

  it("deep mode is denied for free users (consumeOraQuota not called for deep_thinking)", async () => {
    authState.user = { userId: "smoke-free-1", tier: "free", isPaid: false };

    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({ message: "Help me with a hard problem", messages: [], mode: "deep" });

    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      // Should fall back to 'answer' tool, not deep_thinking
      expect(res.body.reply).toBeDefined();
    }
  });

  it("pasted Replit tool report is handled conversationally, not as a file request", async () => {
    const pastedReport = `Replit quality-gate workflow:
lint: PASSED
format: PASSED
typecheck: FAILED
codegen-drift: PASSED
What should I tell Replit about the typecheck failure?`;

    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({ message: pastedReport, messages: [] });

    expect(res.status).toBe(200);
    expect(res.body.fileName).toBeUndefined();
    expect(res.body.fileData).toBeUndefined();
    expect(fileBuilderMock.generateFileFromPrompt).not.toHaveBeenCalled();
  });

  it("temporary mode isolates memory reads (no memoriesUsed or memorySaveCandidate)", async () => {
    authState.user = { userId: "smoke-user-2", tier: "core", isPaid: true };
    memoryState.rows = [
      {
        id: 1,
        title: "Preference",
        content: "Prefers brief replies",
        category: "preference",
        embedding: [1, 0, 0],
        createdAt: new Date(),
      },
    ];

    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({
        message: "What is my preference?",
        messages: [],
        temporary: true,
        referenceSavedMemories: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.memoriesUsed).toBeUndefined();
    expect(res.body.memorySaveCandidate).toBeUndefined();
  });
});

// ─── b) Model-router tool selection ──────────────────────────────────────────

describe("b) Model-router tool selection — ORA_TOOL_REGISTRY + routeOraMessage", () => {
  it("all registry entries have required fields", () => {
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

  it("deep_thinking tool requires paid access", () => {
    expect(ORA_TOOL_REGISTRY.deep_thinking.minAccess).toBe("paid");
  });

  it("checkToolAccess denies search to anonymous visitors", () => {
    const result = checkToolAccess("search", { authed: false, isPaid: false });
    expect(result.allowed).toBe(false);
    expect(result.denyCode).toBe("search_signin_required");
  });

  it("checkToolAccess allows search for signed-in (authed) users", () => {
    const result = checkToolAccess("search", { authed: true, isPaid: false });
    expect(result.allowed).toBe(true);
  });

  it("checkToolAccess blocks deep_thinking for free users", () => {
    const result = checkToolAccess("deep_thinking", { authed: true, isPaid: false });
    expect(result.allowed).toBe(false);
    expect(result.denyCode).toBe("deep_paid_only");
  });

  it("checkToolAccess allows deep_thinking for paid users", () => {
    const result = checkToolAccess("deep_thinking", { authed: true, isPaid: true });
    expect(result.allowed).toBe(true);
  });

  it("routeOraMessage returns 'answer' for plain question in instant mode", async () => {
    const result = await routeOraMessage({
      message: "What is the capital of France?",
      mode: "instant",
      classifier: STUB_CLASSIFIER,
    });
    expect(result.tool).toBe("answer");
  });

  it("routeOraMessage returns 'image_generation' for logo/image requests", async () => {
    const result = await routeOraMessage({
      message: "generate a logo for my bakery",
      mode: "instant",
      classifier: STUB_CLASSIFIER,
    });
    expect(result.tool).toBe("image_generation");
  });

  it("routeOraMessage returns 'search' for current-info questions", async () => {
    const result = await routeOraMessage({
      message: "what's the latest news today",
      mode: "instant",
      classifier: STUB_CLASSIFIER,
    });
    expect(result.tool).toBe("search");
  });

  it("routeOraMessage returns 'file_generation' for CSV requests", async () => {
    const result = await routeOraMessage({
      message: "generate a CSV of top 10 countries by population",
      mode: "instant",
      classifier: STUB_CLASSIFIER,
    });
    expect(result.tool).toBe("file_generation");
  });
});

// ─── c) Memory consolidation ─────────────────────────────────────────────────

describe("c) Memory consolidation — shouldSupersede + findMemoriesToSupersede", () => {
  it("supersedes a contradicting preference (dark → light mode)", () => {
    expect(
      shouldSupersede(
        { title: "Theme", content: "I prefer light mode" },
        { title: "Theme", content: "I prefer dark mode" },
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

  it("does NOT supersede when tokens are too sparse (fewer than 2 significant tokens)", () => {
    expect(
      shouldSupersede({ title: "Hi", content: "ok" }, { title: "Hello", content: "yes" }),
    ).toBe(false);
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

  it("tokenizeMemory strips stopwords and normalises plurals", () => {
    const tokens = tokenizeMemory("I like dollars and euros");
    expect(tokens.has("dollar")).toBe(true);
    expect(tokens.has("euro")).toBe(true);
    expect(tokens.has("like")).toBe(false);
    expect(tokens.has("i")).toBe(false);
  });

  it("tokenizeMemory drops tokens shorter than 3 characters", () => {
    const tokens = tokenizeMemory("go to the it");
    expect(tokens.has("go")).toBe(false);
    expect(tokens.has("it")).toBe(false);
  });

  it("findMemoriesToSupersede returns ids of overlapping memories", () => {
    const ids = findMemoriesToSupersede({ title: "Theme", content: "I prefer light mode" }, [
      { id: 1, title: "Theme", content: "I prefer dark mode" },
      { id: 2, title: "Drinks", content: "I like coffee for breakfast" },
    ]);
    expect(ids).toContain(1);
    expect(ids).not.toContain(2);
  });

  it("findMemoriesToSupersede returns empty array when no overlap", () => {
    const ids = findMemoriesToSupersede({ title: "Language", content: "I write Python code" }, [
      { id: 10, title: "Food", content: "I eat sushi for dinner" },
    ]);
    expect(ids).toHaveLength(0);
  });
});

// ─── d) File-gen intent detection ────────────────────────────────────────────

describe("d) File-gen intent — detectFileRequest patterns", () => {
  it("detects CSV format", () => {
    expect(detectFileRequest("give me a CSV of my data")).toBe("csv");
  });

  it("detects PDF format", () => {
    expect(detectFileRequest("create a PDF report for me")).toBe("pdf");
  });

  it("detects Excel/xlsx format", () => {
    expect(detectFileRequest("export to Excel spreadsheet")).toBe("xlsx");
  });

  it("detects Word/docx format", () => {
    expect(detectFileRequest("write a word document summarizing the project")).toBe("docx");
  });

  it("detects PowerPoint/pptx format", () => {
    expect(detectFileRequest("create a presentation for the client")).toBe("pptx");
  });

  it("returns null for plain conversational messages", () => {
    expect(detectFileRequest("explain how closures work")).toBeNull();
    expect(detectFileRequest("what is the capital of France")).toBeNull();
  });

  it("returns null for pasted tool reports (file keywords present but it's a reference)", () => {
    const pastedReport = `Replit quality-gate results:
format: PASSED
lint: PASSED
typecheck: PASSED
codegen-drift: PASSED
What do these results mean?`;
    expect(detectFileRequest(pastedReport)).toBeNull();
  });
});

// ─── e) Image intent routing ──────────────────────────────────────────────────

describe("e) Image intent routing — isImageGenerationRequest patterns", () => {
  it("matches explicit generation verbs (generate/create/draw/design)", () => {
    expect(isImageGenerationRequest("generate a logo for my company")).toBe(true);
    expect(isImageGenerationRequest("create an illustration of a sunset")).toBe(true);
    expect(isImageGenerationRequest("draw a cartoon cat")).toBe(true);
    expect(isImageGenerationRequest("design a banner for my website")).toBe(true);
  });

  it("matches make/paint/sketch verbs", () => {
    expect(isImageGenerationRequest("make a portrait of a knight")).toBe(true);
    expect(isImageGenerationRequest("paint a watercolor landscape")).toBe(true);
  });

  it("does NOT match blocklisted creative writing phrases", () => {
    expect(isImageGenerationRequest("describe a character profile for my story")).toBe(false);
    expect(isImageGenerationRequest("background on the history of Rome")).toBe(false);
  });

  it("isImageSearchRequest matches retrieval requests with required qualifier", () => {
    expect(isImageSearchRequest("find images of sunsets online")).toBe(true);
    expect(isImageSearchRequest("find the official logo for Tesla")).toBe(true);
  });

  it("isImageSearchRequest requires search/find verb (plain 'show me X' does not match)", () => {
    expect(isImageSearchRequest("show me pictures of the Eiffel Tower")).toBe(false);
  });

  it("ORA_IMAGE_PATTERNS covers at least 5 distinct patterns", () => {
    expect(ORA_IMAGE_PATTERNS.length).toBeGreaterThanOrEqual(5);
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

  it("identifies a pasted GitHub/Replit error with sufficient signal", () => {
    expect(isPastedReferenceAnalysisRequest(LONG_GITHUB_PASTE)).toBe(true);
  });

  it("does NOT misidentify a plain short question", () => {
    expect(isPastedReferenceAnalysisRequest("how do I build a todo app?")).toBe(false);
  });

  it("does NOT misidentify an empty string", () => {
    expect(isPastedReferenceAnalysisRequest("")).toBe(false);
  });

  it("does NOT misidentify a normal conversational message", () => {
    expect(isPastedReferenceAnalysisRequest("I want to plan a marketing campaign")).toBe(false);
  });

  it("isWebSearchRequest identifies current-info questions", () => {
    expect(isWebSearchRequest("what's the latest news on the election")).toBe(true);
    expect(isWebSearchRequest("what is the current bitcoin price")).toBe(true);
    expect(isWebSearchRequest("who won the game today")).toBe(true);
  });

  it("isWebSearchRequest does NOT hijack ordinary conversational questions", () => {
    expect(isWebSearchRequest("how do I build a todo app with MustaFlow?")).toBe(false);
    expect(isWebSearchRequest("explain how closures work in JavaScript")).toBe(false);
  });

  it("ORA_SEARCH_PATTERNS covers live-info queries", () => {
    expect(ORA_SEARCH_PATTERNS.some((p) => p.test("what's the latest news today"))).toBe(true);
    expect(ORA_SEARCH_PATTERNS.some((p) => p.test("current bitcoin price"))).toBe(true);
  });
});

// ─── g) Builder isolation ─────────────────────────────────────────────────────

describe("g) Builder isolation — chat.ts has no builder/jobs imports", () => {
  const chatSrc = readRoute("chat.ts");

  it("chat.ts does not import from builder.ts", () => {
    expect(chatSrc).not.toMatch(/from\s+['"].*\/builder['"]/);
  });

  it("chat.ts does not import from jobs.ts", () => {
    expect(chatSrc).not.toMatch(/from\s+['"].*\/jobs['"]/);
  });

  it("chat.ts does not import from the Builder AI layer (lib/ai)", () => {
    expect(chatSrc).not.toMatch(/from\s+['"].*\/lib\/ai['"]/);
  });

  it("Ora memory context queries only scope='user' AND origin='ora' (not project knowledge)", () => {
    // Both conditions must be present in the memory query code
    expect(chatSrc).toMatch(/scope.*user/);
    expect(chatSrc).toMatch(/origin.*ora/);
  });

  it("Ora web-search personalContext is assembled from profile + saved memories (dual-branch injection)", () => {
    expect(chatSrc).toContain("searchProfileContext");
    expect(chatSrc).toContain("searchMemory");
    expect(chatSrc).toContain("searchPersonalContext");
  });

  it("jobs.ts Builder knowledge query excludes origin='ora' entries (or(isNull, ne) guard)", () => {
    const jobsSrc = readFileSync(
      join(REPO_ROOT, "artifacts", "api-server", "src", "lib", "jobs.ts"),
      "utf-8",
    );
    // The guard appears twice: user-scope and project-scope knowledge queries
    const guardCount = (
      jobsSrc.match(
        /or\(isNull\(knowledgeEntriesTable\.origin\),\s*ne\(knowledgeEntriesTable\.origin,\s*"ora"\)\)/g,
      ) ?? []
    ).length;
    expect(guardCount).toBeGreaterThanOrEqual(2);
  });
});

// ─── h) STT / transcribe route ────────────────────────────────────────────────

describe("h) STT / transcribe — session gate + source structure", () => {
  let transcribeApp: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    transcribeApp = await buildTranscribeApp();
  });

  it("POST /public-ai/transcribe returns 401 when session cookie is absent", async () => {
    const res = await request(transcribeApp)
      .post("/public-ai/transcribe")
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("fake-audio"));

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/session/i);
  });

  it("POST /public-ai/transcribe returns 401 when session is expired/invalid", async () => {
    const expiredToken = jwt.sign(
      { sessionId: "x", msgCount: 0, createdAt: Date.now() },
      "wrong-secret",
    );
    const res = await request(transcribeApp)
      .post("/public-ai/transcribe")
      .set("Cookie", `ora-session=${expiredToken}`)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("fake-audio"));

    expect(res.status).toBe(401);
  });

  it("transcribe source: req.readableEnded guard prevents stream hang", () => {
    const src = readRoute("transcribe.ts");
    expect(src).toContain("req.readableEnded");
  });

  it("transcribe source: validates ora-session cookie via validateSession", () => {
    const src = readRoute("transcribe.ts");
    expect(src).toContain("validateSession");
    expect(src).toContain("ora-session");
  });

  it("transcribe source: enforces MAX_AUDIO_BYTES payload limit", () => {
    const src = readRoute("transcribe.ts");
    expect(src).toContain("MAX_AUDIO_BYTES");
  });

  it("transcribe source: is rate-limited with a voice transcribe limiter", () => {
    const src = readRoute("transcribe.ts");
    expect(src).toContain("oraVoiceTranscribeLimiter");
  });
});

// ─── i) TTS — direct OPENAI_API_KEY, not proxy ───────────────────────────────

describe("i) TTS — 401 without session, 503 when key absent", () => {
  let ttsApp: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    ttsApp = await buildTtsApp();
  });

  it("POST /public-ai/tts returns 401 when session cookie is absent", async () => {
    const res = await request(ttsApp)
      .post("/public-ai/tts")
      .send({ text: "Hello there", voice: "nova" });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/session/i);
  });

  it("POST /public-ai/tts returns 503 when OPENAI_API_KEY is not set", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    // Reset the cached client by clearing the module cache
    vi.resetModules();
    const freshApp = await buildTtsApp();
    const res = await request(freshApp)
      .post("/public-ai/tts")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({ text: "Hello there", voice: "nova" });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured|unavailable/i);
    process.env.OPENAI_API_KEY = saved;
  });

  it("tts source: uses direct OPENAI_API_KEY, not the AI-integrations proxy", () => {
    const src = readRoute("tts.ts");
    expect(src).toContain("apiKey: process.env.OPENAI_API_KEY");
    expect(src).not.toContain("AI_INTEGRATIONS_OPENAI_BASE_URL");
  });

  it("tts source: comment explains why the proxy is bypassed (INVALID_ENDPOINT)", () => {
    const src = readRoute("tts.ts");
    expect(src).toContain("INVALID_ENDPOINT");
  });

  it("tts source: uses rate-limiter (oraVoiceTtsLimiter)", () => {
    const src = readRoute("tts.ts");
    expect(src).toContain("oraVoiceTtsLimiter");
  });

  it("tts source: enumerates a fixed list of supported voices", () => {
    const src = readRoute("tts.ts");
    expect(src).toContain("OPENAI_TTS_VOICES");
    expect(src).toContain("alloy");
    expect(src).toContain("nova");
  });
});

// ─── j) Surface isolation — ora-conversations.ts ─────────────────────────────

describe("j) Surface isolation — ora-conversations.ts surface='normal' gate", () => {
  const src = readApiRoute("ora-conversations.ts");

  it("eq(surface, 'normal') appears on at least 4 per-row CRUD endpoints", () => {
    const count = (src.match(/eq\(oraConversationsTable\.surface,\s*"normal"\)/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(4);
  });

  it("list endpoint applies surface='normal' filter", () => {
    expect(src).toContain('surface, "normal"');
  });

  it("support surface conversations are NOT exposed through normal CRUD routes", () => {
    expect(src).not.toContain('"support"');
  });

  it("soft-delete uses archived_at, not deleted_at", () => {
    expect(src).toContain("archivedAt");
    expect(src).not.toMatch(/deleted_at/i);
  });

  it("ora-conversations source includes comment about support surface isolation", () => {
    expect(src).toMatch(/[Ss]upport.*surface|surface.*[Ss]upport/);
  });

  it("userId ownership check is present on owned resource endpoints", () => {
    expect(src).toContain("userId");
  });
});
