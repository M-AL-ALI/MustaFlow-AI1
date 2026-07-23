import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";
import { evaluateOraResponseQuality } from "../../../lib/public-ai/response-quality";
import { storeFile } from "../../../lib/public-ai/file-store";

const TEST_SECRET = "ora-chat-response-qa-secret";

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
                  topic: user.toLowerCase().includes("api") ? "technical" : "general",
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
        const shouldSave = /remember that i prefer/i.test(user);
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  save: shouldSave,
                  fact: shouldSave ? "Prefers direct answers with minimal steps" : "",
                  explicit: shouldSave,
                  category: shouldSave ? "preference" : "other",
                }),
              },
            },
          ],
        };
      }

      return { choices: [{ message: { content: "{}" } }] };
    }

    return {
      choices: [
        {
          message: {
            content: system.includes("temporary chat")
              ? "I don't have saved memories available in this temporary chat."
              : system.includes("Saved-memory reference is turned off")
                ? "Memory reference is off, so I won't use saved memories for this answer."
                : system.includes("No relevant saved memories")
                  ? "I don't have that saved."
                  : system.includes("From your past conversations")
                    ? "You previously discussed the Core launch checklist in another Ora conversation."
                    : user.includes("42e493f1")
                      ? "Tell Replit: commit 42e493f1 is clean and admin.tsx is wired; ask them to confirm quality-gate and typecheck stay green."
                      : user.includes("What should I tell Replit")
                        ? "Tell Replit: pull the latest commit and run the canonical checks."
                        : user.includes("answer style")
                          ? "You prefer direct answers with minimal steps."
                          : "Direct answer first. Then the minimum useful details.",
          },
        },
      ],
    };
  }),
}));

const fileBuilderMock = vi.hoisted(() => ({
  generateFileFromPrompt: vi.fn(async () => ({
    reply: "Created the CSV file.",
    fileName: "service-packages.csv",
    fileData: Buffer.from("name,price\nBasic,99\n").toString("base64"),
    mimeType: "text/csv",
  })),
}));

const imageMock = vi.hoisted(() => ({
  generateImage: vi.fn(async () => ({
    openaiUrl: "data:image/png;base64,aW1hZ2U=",
    quality: "high",
    providerName: "openai",
    modelName: "gpt-image-1",
    revisedPrompt: "clean logo for mobile mechanic app",
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
    imageCount: 1,
    messageLimit: 100,
    imageLimit: 10,
    windowHours: 24,
    windowStart: null,
    resetsAt: null,
  })),
}));

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
    return new Proxy(
      {},
      {
        get: (_target, prop) => ({ name: String(prop) }),
      },
    ) as Record<string, unknown>;
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

function makeSession(overrides: Record<string, unknown> = {}) {
  const payload = {
    sessionId: "ora-chat-response-qa-" + Math.random().toString(36).slice(2),
    msgCount: 0,
    fileCount: 0,
    imageCount: 0,
    imageAnalysisCount: 0,
    createdAt: Date.now(),
    ...overrides,
  };
  return jwt.sign(payload, TEST_SECRET, { expiresIn: "30m" });
}

async function buildApp() {
  process.env.ORA_SESSION_SECRET = TEST_SECRET;
  process.env.PUBLIC_AI_ENABLED = "true";
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  const router = (await import("../chat")).default;
  app.use(router);
  return app;
}

function mainCompletionCalls() {
  return aiMock.createChatCompletion.mock.calls
    .map(
      (call) =>
        call[0] as { response_format?: { type?: string }; messages?: Array<{ content: string }> },
    )
    .filter((input) => input.response_format?.type === "text");
}

describe("POST /public-ai/chat response QA", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    authState.user = null;
    memoryState.rows = [];
    conversationState.rows = [];
    app = await buildApp();
  });

  it("answers pasted Replit/Codex reports directly without suggestions or artifact claims", async () => {
    const pastedReport = `Pull clean at 42e493f1.
vitest: 3/3 PASS
typecheck: PASS
quality-gate: PASS
admin.tsx wired the panel in.

What should I tell Replit?`;

    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({ message: pastedReport, messages: [] });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe(
      "Tell Replit: commit 42e493f1 is clean and admin.tsx is wired; ask them to confirm quality-gate and typecheck stay green.",
    );
    expect(res.body.suggestions).toEqual([]);
    expect(res.body.fileName).toBeUndefined();
    expect(res.body.fileData).toBeUndefined();
    expect(res.body.imageUrl).toBeUndefined();
    expect(
      evaluateOraResponseQuality({
        scenario: "pasted_report",
        userMessage: pastedReport,
        reply: res.body.reply,
        suggestions: res.body.suggestions,
        requiredEvidence: ["42e493f1", "admin.tsx"],
        maxReplyLines: 2,
        fileName: res.body.fileName,
        fileData: res.body.fileData,
        mimeType: res.body.mimeType,
        imageUrl: res.body.imageUrl,
      }).passed,
    ).toBe(true);

    const [mainCall] = mainCompletionCalls();
    expect(mainCall).toBeDefined();
    const systemPrompt = mainCall.messages?.[0]?.content ?? "";
    expect(systemPrompt).toContain("Current turn: pasted reference analysis");
    expect(systemPrompt).toContain("Start with the direct answer");
    expect(systemPrompt).toContain("Replit = hosted dev/runtime workspace");
    expect(systemPrompt).toContain("Use the minimum useful steps");
    expect(systemPrompt).toContain("Clean response formatting");
    expect(systemPrompt).toContain("Do not use markdown tables");
    expect(systemPrompt).toContain("raw Markdown headings");
    expect(systemPrompt).toContain("Pasted reference signals");
    expect(systemPrompt).toContain("Commits/refs: 42e493f1");
    expect(systemPrompt).toContain("Files mentioned: admin.tsx");
    expect(systemPrompt).toContain("User is asking what to tell: Replit");
    expect(mainCall.messages?.at(-1)?.content).toBe(pastedReport);
    expect(
      aiMock.createChatCompletion.mock.calls.some((call) =>
        JSON.stringify(call[0]).includes("follow-up questions"),
      ),
    ).toBe(false);
  });

  it("injects accounting domain expertise and the answer-specificity directive without offering the AI Builder", async () => {
    const accountingMessage =
      "How should I record accrued payroll on the balance sheet under GAAP, and what month-end close journal entry do I post?";

    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({ message: accountingMessage, messages: [] });

    expect(res.status).toBe(200);
    const [mainCall] = mainCompletionCalls();
    expect(mainCall).toBeDefined();
    const systemPrompt = mainCall.messages?.[0]?.content ?? "";
    expect(systemPrompt).toContain("Domain: accounting");
    expect(systemPrompt).toContain("general accounting information");
    expect(systemPrompt).toContain("licensed CPA");
    expect(systemPrompt).toContain("Answer specificity");
    expect(systemPrompt).not.toMatch(/MustaFlow Builder|Continue in Builder|ready to build/i);
  });

  it("returns generated-file fields only when the file branch actually creates an artifact", async () => {
    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({ message: "Create a CSV of my service packages.", messages: [] });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("Created the CSV file.");
    expect(res.body.fileName).toBe("service-packages.csv");
    expect(res.body.fileData).toBe(Buffer.from("name,price\nBasic,99\n").toString("base64"));
    expect(res.body.mimeType).toBe("text/csv");
    expect(res.body.imageUrl).toBeUndefined();
    expect(fileBuilderMock.generateFileFromPrompt).toHaveBeenCalledTimes(1);
    expect(mainCompletionCalls()).toEqual([]);
    expect(
      evaluateOraResponseQuality({
        scenario: "file_generation",
        userMessage: "Create a CSV of my service packages.",
        reply: res.body.reply,
        fileName: res.body.fileName,
        fileData: res.body.fileData,
        mimeType: res.body.mimeType,
      }).passed,
    ).toBe(true);
  });

  it("routes natural AppSheet workbook requests through the file branch as XLSX", async () => {
    fileBuilderMock.generateFileFromPrompt.mockResolvedValueOnce({
      reply: "Created the AppSheet-ready workbook.",
      fileName: "field-inspection-app.xlsx",
      fileData: Buffer.from("appsheet workbook").toString("base64"),
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({ message: "I need an AppSheet app for field inspections.", messages: [] });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("Created the AppSheet-ready workbook.");
    expect(res.body.fileName).toBe("field-inspection-app.xlsx");
    expect(res.body.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(fileBuilderMock.generateFileFromPrompt).toHaveBeenCalledTimes(1);
    const [filePrompt, fileFormat] = fileBuilderMock.generateFileFromPrompt.mock
      .calls[0] as unknown as [string, string];
    expect(filePrompt).toContain("AppSheet app for field inspections");
    expect(fileFormat).toBe("xlsx");
    expect(mainCompletionCalls()).toEqual([]);
  });

  it("destructive uploaded-file edits show a preview-confirmation before generating the file", async () => {
    const sessionId = "ora-chat-uploaded-edit-session";
    const fileRef = storeFile({
      sessionId,
      filename: "quarterly-board-deck.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      extractedText: [
        "[POWERPOINT STRUCTURE — slide text extracted from the uploaded deck]",
        "Slide 1:",
        "- Executive Summary",
        "Slide 2:",
        "- Pricing plan",
        "Slide 3:",
        "- Legacy roadmap",
      ].join("\n"),
      charCount: 160,
    });

    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession({ sessionId })}`)
      .send({
        message: "Delete slide 3 and send it back",
        messages: [],
        documentRefs: [fileRef],
      });

    expect(res.status).toBe(200);
    expect(fileBuilderMock.generateFileFromPrompt).not.toHaveBeenCalled();
    expect(res.body.clarificationKind).toBe("file_edit_preview_confirmation");
    expect(res.body.pendingTaskContext?.kind).toBe("file_edit_preview_confirmation");
    expect(res.body.fileAgentPreview?.status).toBe("needs_confirmation");
    expect(res.body.reply).toContain("confirmation");
  });

  it("returns inline image fields for signed-in image generation without sign-in hedging", async () => {
    authState.user = { userId: "ora-user-1", tier: "core", isPaid: true };

    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({ message: "Create a clean logo for my mobile mechanic app.", messages: [] });

    expect(res.status).toBe(200);
    expect(res.body.reply).toContain("Here's the image you asked for");
    expect(res.body.reply).not.toMatch(/sign in|sign up|create an account/i);
    expect(res.body.imageUrl).toBe("data:image/png;base64,aW1hZ2U=");
    expect(res.body.imageMeta).toEqual({
      kind: "logo",
      aspectRatio: "1:1",
      style: "natural",
      quality: "high",
    });
    expect(res.body.fileName).toBeUndefined();
    expect(imageMock.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        aspectRatio: "1:1",
        quality: "high",
        style: "natural",
        subscriptionTier: "core",
      }),
    );
    expect(usageMock.consumeOraQuota).toHaveBeenCalledWith("ora-user-1", "core", "image");
    expect(
      evaluateOraResponseQuality({
        scenario: "image_generation",
        signedIn: true,
        userMessage: "Create a clean logo for my mobile mechanic app.",
        reply: res.body.reply,
        imageUrl: res.body.imageUrl,
      }).passed,
    ).toBe(true);
  });

  it("surfaces memoriesUsed chips and injects saved memory context into the model prompt", async () => {
    authState.user = { userId: "ora-user-2", tier: "core", isPaid: true };
    memoryState.rows = [
      {
        id: 42,
        title: "Answer style",
        content: "Prefers direct answers with minimal steps",
        category: "preference",
        embedding: [1, 0, 0],
        createdAt: new Date(),
      },
    ];

    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({
        message: "What answer style do I prefer?",
        messages: [],
        referenceSavedMemories: true,
        referenceChatHistory: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("You prefer direct answers with minimal steps.");
    expect(res.body.memoriesUsed).toEqual([{ id: 42, title: "Answer style" }]);
    expect(
      evaluateOraResponseQuality({
        scenario: "memory_recall",
        userMessage: "What answer style do I prefer?",
        reply: res.body.reply,
        memoriesUsed: res.body.memoriesUsed,
      }).passed,
    ).toBe(true);

    const [mainCall] = mainCompletionCalls();
    const systemPrompt = mainCall.messages?.[0]?.content ?? "";
    expect(systemPrompt).toContain("## Saved memories");
    expect(systemPrompt).toContain("Prefers direct answers with minimal steps");
  });

  it("does not surface a saved answer-style memory that conflicts with the current message", async () => {
    authState.user = { userId: "ora-user-2", tier: "core", isPaid: true };
    memoryState.rows = [
      {
        id: 42,
        title: "Answer style",
        content: "Prefers direct answers with minimal steps",
        category: "preference",
        embedding: [1, 0, 0],
        createdAt: new Date(),
      },
    ];

    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({
        message: "Actually, from now on I prefer detailed explanations with reasoning.",
        messages: [],
        referenceSavedMemories: true,
        referenceChatHistory: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.memoriesUsed).toBeUndefined();

    const [mainCall] = mainCompletionCalls();
    const systemPrompt = mainCall.messages?.[0]?.content ?? "";
    expect(systemPrompt).not.toContain("## Saved memories");
    expect(systemPrompt).not.toContain("Prefers direct answers with minimal steps");
  });

  it("does not fake memory recall when no relevant saved memories are available", async () => {
    authState.user = { userId: "ora-user-2", tier: "core", isPaid: true };
    memoryState.rows = [];

    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({
        message: "What do you remember about my answer style?",
        messages: [],
        referenceSavedMemories: true,
        referenceChatHistory: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("I don't have that saved.");
    expect(res.body.memoriesUsed).toBeUndefined();

    const [mainCall] = mainCompletionCalls();
    const systemPrompt = mainCall.messages?.[0]?.content ?? "";
    expect(systemPrompt).toContain("No relevant saved memories");
    expect(systemPrompt).toContain("say you do not have that saved instead of guessing");
  });

  it("honors the Memory Center reference toggle by skipping saved memories", async () => {
    authState.user = { userId: "ora-user-2", tier: "core", isPaid: true };
    memoryState.rows = [
      {
        id: 42,
        title: "Answer style",
        content: "Prefers direct answers with minimal steps",
        category: "preference",
        embedding: [1, 0, 0],
        createdAt: new Date(),
      },
    ];

    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({
        message: "What answer style do I prefer?",
        messages: [],
        referenceSavedMemories: false,
        referenceChatHistory: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe(
      "Memory reference is off, so I won't use saved memories for this answer.",
    );
    expect(res.body.memoriesUsed).toBeUndefined();

    const [mainCall] = mainCompletionCalls();
    const systemPrompt = mainCall.messages?.[0]?.content ?? "";
    expect(systemPrompt).toContain("Saved-memory reference is turned off");
    expect(systemPrompt).not.toContain("## Saved memories");
    expect(systemPrompt).not.toContain("Prefers direct answers with minimal steps");
  });

  it("uses relevant past-conversation summaries without surfacing memoriesUsed chips", async () => {
    authState.user = { userId: "ora-user-2", tier: "core", isPaid: true };
    conversationState.rows = [
      {
        id: 10,
        title: "Core launch checklist",
        summary: "The user discussed a Core launch checklist for Ora memory validation.",
        lastMessageAt: new Date(),
      },
    ];

    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({
        message: "What did we discuss about the Core launch checklist?",
        messages: [],
        referenceSavedMemories: true,
        referenceChatHistory: true,
        conversationId: 99,
      });

    expect(res.status).toBe(200);
    expect(res.body.reply).toContain("Core launch checklist");
    expect(res.body.memoriesUsed).toBeUndefined();

    const [mainCall] = mainCompletionCalls();
    const systemPrompt = mainCall.messages?.[0]?.content ?? "";
    expect(systemPrompt).toContain("## From your past conversations");
    expect(systemPrompt).toContain("Core launch checklist");
    expect(systemPrompt).not.toContain("## Saved memories");
  });

  it("keeps temporary chats isolated from saved memory reads and writes", async () => {
    authState.user = { userId: "ora-user-2", tier: "core", isPaid: true };
    memoryState.rows = [
      {
        id: 42,
        title: "Answer style",
        content: "Prefers direct answers with minimal steps",
        category: "preference",
        embedding: [1, 0, 0],
        createdAt: new Date(),
      },
    ];

    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({
        message: "What answer style do I prefer?",
        messages: [],
        temporary: true,
        referenceSavedMemories: true,
        referenceChatHistory: true,
        conversationSummary: "Earlier saved summary that must not enter temporary mode.",
        summarizeMessages: [
          {
            role: "user",
            content: "Old non-temporary context",
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("I don't have saved memories available in this temporary chat.");
    expect(res.body.memoriesUsed).toBeUndefined();
    expect(res.body.memorySaveCandidate).toBeUndefined();
    expect(res.body.conversationSummary).toBeUndefined();

    const [mainCall] = mainCompletionCalls();
    const systemPrompt = mainCall.messages?.[0]?.content ?? "";
    expect(systemPrompt).toContain("This is a temporary chat");
    expect(systemPrompt).not.toContain("## Saved memories");
    expect(systemPrompt).not.toContain("## Earlier in this conversation");
    expect(systemPrompt).not.toContain("Earlier saved summary");
    expect(systemPrompt).not.toContain("Prefers direct answers with minimal steps");
  });

  it("surfaces memory-save candidate chips without persisting automatically", async () => {
    authState.user = { userId: "ora-user-3", tier: "core", isPaid: true };

    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${makeSession()}`)
      .send({
        message: "Remember that I prefer direct answers with minimal steps.",
        messages: [],
        referenceSavedMemories: false,
        referenceChatHistory: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.memorySaveCandidate).toBe("Prefers direct answers with minimal steps");
    expect(res.body.memorySaveCandidateConfidence).toBe("high");
    expect(res.body.memorySaveCandidateSensitive).toBe(false);
    expect(res.body.memoriesUsed).toBeUndefined();
  });
});
