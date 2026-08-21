import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import * as http from "http";
import express from "express";
import cookieParser from "cookie-parser";
import { extractIfStatementByCondition } from "../../../lib/source-ast-test-helper";

process.env.DATABASE_URL ??= "postgres://ora-streaming-test:ora-streaming-test@localhost:5432/ora";

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any imports that pull the real modules.
// ---------------------------------------------------------------------------

const createSessionTokenMock = vi.hoisted(() => vi.fn());
const validateSessionMock = vi.hoisted(() => vi.fn());
const incrementMessageCountMock = vi.hoisted(() => vi.fn());
const setSessionCookieMock = vi.hoisted(() => vi.fn());
const isOraSecretConfiguredMock = vi.hoisted(() => vi.fn().mockReturnValue(true));
const markSessionAsPreIncrementedMock = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    token: "pre-incremented-token",
    payload: {
      msgCount: 1,
      imageCount: 0,
      streamingPreIncremented: true,
    },
  }),
);
const acknowledgeStreamingIncrementMock = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    token: "acknowledged-token",
    payload: { msgCount: 1, imageCount: 0 },
  }),
);
const createStreamFallbackTokenMock = vi.hoisted(() =>
  vi.fn().mockReturnValue("fake-fallback-jwt"),
);
const verifyStreamFallbackTokenMock = vi.hoisted(() => vi.fn().mockReturnValue(false));

// streamChatCompletion mock: yields two token deltas then returns.
const streamChatCompletionMock = vi.hoisted(() =>
  vi.fn(async function* (): AsyncGenerator<string> {
    yield " Hello";
    yield " World";
  }),
);
const createChatCompletionMock = vi.hoisted(() => vi.fn().mockResolvedValue(""));

const consumeOraQuotaMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ allowed: true, limit: 100, used: 1 }),
);
const getOraUsageMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    messageCount: 1,
    messageLimit: 100,
    imageCount: 0,
    imageLimit: 10,
    resetsAt: null,
  }),
);

const extractProseVideosMock = vi.hoisted(() =>
  vi.fn().mockImplementation((text: string) => ({ text, videos: [] })),
);
const verifyVideosMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock("../../../lib/public-ai/session", () => ({
  createSessionToken: createSessionTokenMock,
  validateSession: validateSessionMock,
  incrementMessageCount: incrementMessageCountMock,
  markSessionAsPreIncremented: markSessionAsPreIncrementedMock,
  acknowledgeStreamingIncrement: acknowledgeStreamingIncrementMock,
  setSessionCookie: setSessionCookieMock,
  isOraSecretConfigured: isOraSecretConfiguredMock,
  createStreamFallbackToken: createStreamFallbackTokenMock,
  verifyStreamFallbackToken: verifyStreamFallbackTokenMock,
  MSG_LIMIT_VALUE: 10,
}));

vi.mock("../../../lib/public-ai/authed-user", () => ({
  resolveAuthedOraUser: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../../lib/public-ai/orchestrator", () => ({
  routeOraMessage: vi.fn().mockResolvedValue({
    tool: "conversational",
    intent: "simple_faq",
    confidence: "medium",
    topic: "general",
    reason: "",
  }),
  checkToolAccess: vi.fn().mockReturnValue({ allowed: true }),
  extractMemorySaveCandidate: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../../lib/public-ai/carried-docs", () => ({
  buildCarriedDocumentContext: vi.fn().mockResolvedValue(""),
}));

vi.mock("../../../lib/public-ai/expertise", () => ({
  buildOraExpertiseProfile: vi.fn().mockReturnValue({
    systemAddendum: "",
    maxTokens: 1024,
    domain: "general",
    depth: "standard",
  }),
}));

vi.mock("../../../lib/public-ai/model-router", () => ({
  getOraProviderRoutingSnapshot: vi.fn().mockReturnValue({ available: [], openCircuits: [] }),
  openAiModelForOraRoute: vi.fn().mockReturnValue("gpt-5-mini"),
  normalizeOraPlanTier: vi.fn().mockReturnValue("free"),
  selectOraModelRoute: vi.fn().mockReturnValue([{ provider: "openai", model: "gpt-5-mini" }]),
  runCandidateChain: vi.fn().mockResolvedValue({
    result: { choices: [{ message: { content: "Test reply" } }] },
    usedFallback: false,
    candidate: { provider: "openai", model: "gpt-5-mini" },
  }),
  MODEL_DEFAULTS: {},
  isDeepSeekAvailable: vi.fn().mockReturnValue(false),
  classifyProviderError: vi.fn().mockReturnValue("unknown"),
}));

vi.mock("../../../lib/public-ai/memory", () => ({
  buildMemoryContext: vi.fn().mockResolvedValue({ text: "", used: [] }),
}));

vi.mock("../../../lib/public-ai/profile-context", () => ({
  buildProfileContext: vi.fn().mockResolvedValue(""),
}));

vi.mock("../../../lib/public-ai/cross-conversation", () => ({
  buildCrossConversationContext: vi.fn().mockResolvedValue(""),
}));

vi.mock("../../../lib/public-ai/memory-status-context", () => ({
  buildMemoryStatusContext: vi.fn().mockReturnValue(""),
}));

vi.mock("../../../lib/public-ai/suggestions", () => ({
  topicSuggestionGuidance: vi.fn().mockReturnValue(""),
}));

vi.mock("../../../lib/public-ai/memory-extract", () => ({
  extractMemorySaveCandidate: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../../lib/public-ai/user-input-scan", () => ({
  scanUserInput: vi.fn().mockReturnValue(true),
}));

vi.mock("../../../lib/public-ai/pasted-reference", () => ({
  isPastedReferenceAnalysisRequest: vi.fn().mockReturnValue(false),
  summarizePastedReferenceSignals: vi.fn().mockReturnValue(""),
}));

// Both the streaming and non-streaming /chat routes dynamically import
// `../../lib/ai-providers` (src/lib/ai-providers.ts) to get streamChatCompletion
// and createChatCompletion. Mocking the same resolved path intercepts those
// dynamic imports in both route handlers.
vi.mock("../../../lib/ai-providers", () => ({
  streamChatCompletion: streamChatCompletionMock,
  createChatCompletion: createChatCompletionMock,
}));

vi.mock("../../../lib/public-ai/ora-usage", () => ({
  consumeOraQuota: consumeOraQuotaMock,
  getOraUsage: getOraUsageMock,
  refundOraQuota: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/public-ai/web-search", () => ({
  extractProseVideos: extractProseVideosMock,
  verifyVideos: verifyVideosMock,
}));
// ---------------------------------------------------------------------------
// Helper to create a minimal test Express app that mounts the public-ai router.
// ---------------------------------------------------------------------------

async function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // The public-ai routes are registered with their FULL paths ("/public-ai/chat",
  // "/public-ai/chat/stream", etc.) so the router must be mounted at root,
  // matching the production setup in routes/index.ts: router.use(publicAiRouter).
  const { default: publicAiRouter } = await import("../index");
  app.use(publicAiRouter);
  return app;
}

// ---------------------------------------------------------------------------
// SSE response parser: split raw body into typed event objects.
// ---------------------------------------------------------------------------

function parseSSEEvents(rawBody: string): Array<Record<string, unknown>> {
  return rawBody
    .split("\n\n")
    .filter(Boolean)
    .flatMap((block) => {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) return [];
      try {
        return [JSON.parse(dataLine.slice(6)) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

// ---------------------------------------------------------------------------
// Minimal valid body for the streaming endpoint.
// ---------------------------------------------------------------------------

const VALID_BODY = {
  message: "Hello Ora",
  messages: [],
};

// A valid fake session token (non-null validateSession return).
const FAKE_SESSION = {
  sessionId: "test-session-id",
  msgCount: 0,
  imageCount: 0,
  streamingPreIncremented: false,
};

// A session at the anonymous message limit — triggers 429.
const LIMIT_SESSION = {
  sessionId: "limit-session-id",
  msgCount: 10, // == MSG_LIMIT_VALUE mock value
  imageCount: 0,
  streamingPreIncremented: false,
};

// ---------------------------------------------------------------------------
// Helper: parse SSE text into a map of { eventType -> parsed[] }
// ---------------------------------------------------------------------------

function parseSseEvents(text: string): Record<string, unknown[]> {
  const map: Record<string, unknown[]> = {};
  for (const frame of text.split("\n\n")) {
    if (!frame.trim()) continue;
    let eventType: string | null = null;
    let dataLine: string | null = null;
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) eventType = line.slice(7).trim();
      else if (line.startsWith("data: ")) dataLine = line.slice(6).trim();
    }
    if (!eventType || !dataLine) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataLine);
    } catch {
      parsed = dataLine;
    }
    (map[eventType] ??= []).push(parsed);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Tests — gating, specialist fallback, and isolation (original 8 tests)
// ---------------------------------------------------------------------------

describe("POST /public-ai/chat/stream", () => {
  beforeEach(() => {
    validateSessionMock.mockReturnValue(FAKE_SESSION);
    incrementMessageCountMock.mockReturnValue({
      token: "updated-token",
      payload: { msgCount: 1, imageCount: 0 },
    });
    setSessionCookieMock.mockImplementation(() => undefined);
    markSessionAsPreIncrementedMock.mockReturnValue({
      token: "pre-incremented-token",
      payload: { msgCount: 1, imageCount: 0, streamingPreIncremented: true },
    });
    acknowledgeStreamingIncrementMock.mockReturnValue({
      token: "acknowledged-token",
      payload: { msgCount: 1, imageCount: 0 },
    });
    // Reset streaming mock to default (2 tokens then done)
    streamChatCompletionMock.mockImplementation(async function* () {
      yield " Hello";
      yield " World";
    });
    createChatCompletionMock.mockResolvedValue("");
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.ORA_STREAMING_ENABLED;
  });

  // ── Gate: feature flag ────────────────────────────────────────────────────

  it("returns 503 when ORA_STREAMING_ENABLED is not set", async () => {
    delete process.env.ORA_STREAMING_ENABLED;
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send(VALID_BODY);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  it("returns 503 when ORA_STREAMING_ENABLED is 'false' (explicit disable)", async () => {
    process.env.ORA_STREAMING_ENABLED = "false";
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send(VALID_BODY);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ streamingFallback: true });
  });

  // ── Gate: validation ─────────────────────────────────────────────────────

  it("returns 400 on an invalid (empty message) body", async () => {
    process.env.ORA_STREAMING_ENABLED = "true";
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send({ message: "", messages: [] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  it("returns 401 when no ora-session cookie is present", async () => {
    process.env.ORA_STREAMING_ENABLED = "true";
    const app = await buildTestApp();
    const res = await request(app).post("/public-ai/chat/stream").send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it("returns 401 when ora-session cookie is invalid (validateSession returns null)", async () => {
    process.env.ORA_STREAMING_ENABLED = "true";
    validateSessionMock.mockReturnValue(null);
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=expired")
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  // ── Gate: rate limit ─────────────────────────────────────────────────────

  it("returns 429 when anonymous session has reached the message limit", async () => {
    process.env.ORA_STREAMING_ENABLED = "true";
    validateSessionMock.mockReturnValue(LIMIT_SESSION);
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=limit")
      .send(VALID_BODY);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ upgradeCta: true });
  });

  // ── Streaming fallback: specialist tools ─────────────────────────────────

  it("emits streamingFallback JSON for file_generation tool", async () => {
    process.env.ORA_STREAMING_ENABLED = "true";
    const { routeOraMessage } = await import("../../../lib/public-ai/orchestrator");
    vi.mocked(routeOraMessage).mockResolvedValueOnce({
      tool: "file_generation",
      intent: "simple_faq",
      confidence: "high",
      topic: "general",
      reason: "",
    });
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ streamingFallback: true });
  });

  it("emits streamingFallback JSON for image_generation tool", async () => {
    process.env.ORA_STREAMING_ENABLED = "true";
    const { routeOraMessage } = await import("../../../lib/public-ai/orchestrator");
    vi.mocked(routeOraMessage).mockResolvedValueOnce({
      tool: "image_generation",
      intent: "simple_faq",
      confidence: "high",
      topic: "general",
      reason: "",
    });
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ streamingFallback: true });
  });

  it("emits streamingFallback JSON for search tool", async () => {
    process.env.ORA_STREAMING_ENABLED = "true";
    const { routeOraMessage } = await import("../../../lib/public-ai/orchestrator");
    vi.mocked(routeOraMessage).mockResolvedValueOnce({
      tool: "search",
      intent: "simple_faq",
      confidence: "high",
      topic: "general",
      reason: "",
    });
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ streamingFallback: true });
  });

  // ── Successful SSE stream ─────────────────────────────────────────────────

  it("successful stream: response Content-Type is text/event-stream", async () => {
    process.env.ORA_STREAMING_ENABLED = "true";
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send(VALID_BODY)
      .buffer(true);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
  });

  it("successful stream: first event type is 'start'", async () => {
    process.env.ORA_STREAMING_ENABLED = "true";
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send(VALID_BODY)
      .buffer(true);
    // The very first SSE frame should be the `start` event.
    const firstFrame = res.text.split("\n\n")[0] ?? "";
    expect(firstFrame).toMatch(/event:\s*start/);
  });

  it("successful stream: token events carry a 'text' field (not 'delta')", async () => {
    process.env.ORA_STREAMING_ENABLED = "true";
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send(VALID_BODY)
      .buffer(true);
    const events = parseSseEvents(res.text);
    const tokens = events["token"] ?? [];
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) {
      expect(t as Record<string, unknown>).toHaveProperty("text");
      expect(t as Record<string, unknown>).not.toHaveProperty("delta");
    }
  });

  it("regression: streams MULTIPLE discrete token events incrementally (not one buffered reply)", async () => {
    process.env.ORA_STREAMING_ENABLED = "true";
    // Yield three distinct deltas so "multiple" is unambiguous: this proves the
    // UI receives content as separate token frames as they arrive, rather than a
    // single buffered final response. This is the core streaming guarantee.
    streamChatCompletionMock.mockImplementationOnce(async function* () {
      yield "The ";
      yield "quick ";
      yield "fox";
    });
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send(VALID_BODY)
      .buffer(true);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    // Ordered list of SSE event names, read from each frame's `event:` line.
    const eventOrder = res.text
      .split("\n\n")
      .map((frame) =>
        frame
          .split("\n")
          .find((l) => l.startsWith("event: "))
          ?.slice(7)
          .trim(),
      )
      .filter((e): e is string => Boolean(e));

    // There must be at least two discrete token frames (incremental delivery).
    const tokenCount = eventOrder.filter((e) => e === "token").length;
    expect(tokenCount).toBeGreaterThanOrEqual(2);

    // Token texts, concatenated in arrival order, reconstruct the full reply.
    const tokens = (parseSseEvents(res.text)["token"] ?? []) as Array<{ text?: string }>;
    const streamedText = tokens.map((t) => t.text ?? "").join("");
    expect(streamedText).toBe("The quick fox");

    // Ordering: first frame is `start`; the final `token` precedes the single
    // terminal `done` event.
    expect(eventOrder[0]).toBe("start");
    const firstTokenIdx = eventOrder.indexOf("token");
    const lastTokenIdx = eventOrder.lastIndexOf("token");
    const doneIdx = eventOrder.indexOf("done");
    expect(firstTokenIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(lastTokenIdx);
    expect(eventOrder.filter((e) => e === "done").length).toBe(1);
  });

  it("successful stream: done event carries an 'isRealStreaming' field", async () => {
    process.env.ORA_STREAMING_ENABLED = "true";
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send(VALID_BODY)
      .buffer(true);
    const events = parseSseEvents(res.text);
    const doneEvents = events["done"] ?? [];
    expect(doneEvents.length).toBe(1);
    const payload = ((doneEvents[0] as Record<string, unknown>).payload ?? doneEvents[0]) as Record<
      string,
      unknown
    >;
    expect(payload).toHaveProperty("isRealStreaming");
  });

  it("SSE error before first token: error event has a 'code' field", async () => {
    process.env.ORA_STREAMING_ENABLED = "true";
    // Make the streaming provider throw immediately (no tokens emitted).
    streamChatCompletionMock.mockImplementationOnce(async function* () {
      throw new Error("provider unavailable");
      yield " Hello"; // unreachable — satisfies TS return-type inference
    });
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send(VALID_BODY)
      .buffer(true);
    // The server sends SSE headers then writes an error frame.
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const events = parseSseEvents(res.text);
    const errorEvents = events["error"] ?? [];
    expect(errorEvents.length).toBeGreaterThan(0);
    const ev = errorEvents[0] as Record<string, unknown>;
    expect(ev).toHaveProperty("code");
    // A pre-first-token error should emit code "stream_failed"
    expect(ev.code).toBe("stream_failed");
  });

  // ── Latency: fast first token ─────────────────────────────────────────────

  it("Instant live stream disables provider thinking for a fast first token", async () => {
    process.env.ORA_STREAMING_ENABLED = "true";
    const app = await buildTestApp();
    await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send(VALID_BODY)
      .buffer(true);
    // Instant chat must request a fast first token so provider thinking phases
    // cannot leave the bubble empty for several seconds.
    expect(streamChatCompletionMock).toHaveBeenCalled();
    // The mock is declared with no params, so widen the recorded calls to the
    // real param shape before asserting on the first argument.
    const calls = streamChatCompletionMock.mock.calls as unknown as Array<
      [{ disableThinking?: boolean }]
    >;
    for (const [params] of calls) {
      expect(params).toMatchObject({ disableThinking: true });
    }
  });

  it("Deep Thinking stream enables provider reasoning and emits stage status", async () => {
    process.env.ORA_STREAMING_ENABLED = "true";
    const { routeOraMessage } = await import("../../../lib/public-ai/orchestrator");
    vi.mocked(routeOraMessage).mockResolvedValueOnce({
      tool: "deep_thinking",
      intent: "premium",
      confidence: "high",
      topic: "general",
      reason: "requested_deep_mode",
    });

    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send({
        ...VALID_BODY,
        mode: "deep",
        message: "Think deeply about the tradeoffs between queues and event streams.",
      })
      .buffer(true);

    expect(res.status).toBe(200);
    const calls = streamChatCompletionMock.mock.calls as unknown as Array<
      [{ disableThinking?: boolean }]
    >;
    expect(calls[calls.length - 1]?.[0]).toMatchObject({ disableThinking: false });

    const events = parseSseEvents(res.text);
    const statusTexts = ((events["status"] ?? []) as Array<{ text?: string }>)
      .map((ev) => ev.text)
      .filter((text): text is string => typeof text === "string");
    expect(statusTexts).toEqual(
      expect.arrayContaining([
        "Deep Thinking: preparing the reasoning plan...",
        "Deep Thinking: reasoning through the answer...",
        "Deep Thinking: finalizing the answer...",
      ]),
    );
  });

  it("non-streaming chat fallback keeps provider reasoning enabled for Deep Thinking", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../chat.ts"), "utf8");
    expect(src).toContain("disableThinking: !deepAllowed");
  });

  // ── Isolation tests ───────────────────────────────────────────────────────

  it("Ora isolation: stream-adapter.ts source contains no Builder handoff strings", async () => {
    // This test proves the streaming infrastructure cannot leak Builder references
    // through the SSE channel. It reads the source file as a string and asserts
    // that the Ora-isolation forbidden tokens are absent.
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../../lib/public-ai/stream-adapter.ts"),
      "utf8",
    );
    const forbidden = [
      "handoffCta",
      "builder_handoff",
      "MustaFlow Builder",
      "Continue in Builder",
      "ready to build",
      "/api/public-ai/handoff/create",
      "/api/builder/handoff/exchange",
    ];
    for (const token of forbidden) {
      expect(src, `stream-adapter.ts must not contain "${token}"`).not.toContain(token);
    }
  });

  it("Ora isolation: chat.ts streaming route source contains no Builder handoff strings", async () => {
    // Proves that the streaming route handler itself cannot inject Builder
    // references through the SSE event data or done payload.
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../chat.ts"), "utf8");
    const forbidden = [
      "handoffCta",
      "builder_handoff",
      "MustaFlow Builder",
      "Continue in Builder",
      "ready to build",
    ];
    for (const token of forbidden) {
      expect(src, `chat.ts must not contain "${token}"`).not.toContain(token);
    }
  });

  // ── Quota accounting ──────────────────────────────────────────────────────

  it("quota accounting: refundOraQuotaFor is gated on !firstTokenSent in source", async () => {
    // Structural guard: the quota refund in the streaming error path must live
    // inside a `!firstTokenSent` block so post-token interruptions never
    // trigger a refund (the user received partial content → one turn consumed).
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../chat.ts"), "utf8");
    const errorBlock = extractIfStatementByCondition(src, "streamFailed || !streamedReply.trim()");
    expect(errorBlock).toContain("streamFailed || !streamedReply.trim()");
    // The !firstTokenSent guard must exist inside the error block…
    expect(errorBlock).toContain("!firstTokenSent");
    // …and it must appear BEFORE the refund call.
    expect(errorBlock.indexOf("!firstTokenSent")).toBeLessThan(
      errorBlock.indexOf("refundOraQuotaFor"),
    );
  });

  it("SSE error after first token: error event has code 'stream_interrupted'", async () => {
    process.env.ORA_STREAMING_ENABLED = "true";
    // Yield one token, then throw — simulates a mid-stream provider cut.
    streamChatCompletionMock.mockImplementationOnce(async function* (): AsyncGenerator<string> {
      yield " partial";
      throw new Error("provider cut stream");
    });
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send(VALID_BODY)
      .buffer(true);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const events = parseSseEvents(res.text);
    const errorEvents = events["error"] ?? [];
    expect(errorEvents.length).toBeGreaterThan(0);
    const ev = errorEvents[0] as Record<string, unknown>;
    // Post-first-token: code must be "stream_interrupted" (NOT "stream_failed")
    expect(ev.code).toBe("stream_interrupted");
  });

  // ── chargeSession / streamFallbackToken ───────────────────────────────────

  // The next three tests exercise the non-streaming /chat route to verify
  // chargeSession correctly guards acknowledgeStreamingIncrement behind a
  // cryptographically-verified streamFallbackToken — preventing a stale
  // streamingPreIncremented cookie from silently undercharging an independent
  // turn.

  it("/chat without streamFallbackToken: uses incrementMessageCount even with stale streamingPreIncremented", async () => {
    // A successful streaming turn left a stale streamingPreIncremented:true
    // cookie. The NEXT user message (no token) must be charged normally.
    validateSessionMock.mockReturnValue({
      ...FAKE_SESSION,
      streamingPreIncremented: true as const,
      msgCount: 1,
    });
    createChatCompletionMock.mockResolvedValueOnce("A helpful reply");
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", "ora-session=stale-flag")
      .send(VALID_BODY); // no streamFallbackToken
    expect(res.status).toBe(200);
    // incrementMessageCount must be called (normal charge — no token presented)
    expect(incrementMessageCountMock).toHaveBeenCalled();
    // acknowledgeStreamingIncrement must NOT be called (no valid token)
    expect(acknowledgeStreamingIncrementMock).not.toHaveBeenCalled();
  });

  it("/chat with valid streamFallbackToken + streamingPreIncremented: acknowledges without double-charging", async () => {
    // Streaming pre-incremented the session but failed before the first token.
    // Client retries via /chat with the server-signed fallback token.
    validateSessionMock.mockReturnValue({
      ...FAKE_SESSION,
      streamingPreIncremented: true as const,
      msgCount: 1,
    });
    // verifyStreamFallbackToken returns true for a valid token
    verifyStreamFallbackTokenMock.mockReturnValueOnce(true);
    createChatCompletionMock.mockResolvedValueOnce("A helpful reply");
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", "ora-session=pre-incremented")
      .send({ ...VALID_BODY, streamFallbackToken: "valid-jwt" });
    expect(res.status).toBe(200);
    // acknowledgeStreamingIncrement must be called (clears flag, no double charge)
    expect(acknowledgeStreamingIncrementMock).toHaveBeenCalled();
    // incrementMessageCount must NOT be called (would be a double-charge)
    expect(incrementMessageCountMock).not.toHaveBeenCalled();
  });

  it("/chat with invalid streamFallbackToken (verify returns false): falls through to incrementMessageCount", async () => {
    // verifyStreamFallbackToken returns false — expired or forged token.
    // The server must not honour the pre-increment claim and must charge normally.
    validateSessionMock.mockReturnValue({
      ...FAKE_SESSION,
      streamingPreIncremented: true as const,
      msgCount: 1,
    });
    // verifyStreamFallbackTokenMock defaults to returning false — expired / forged
    createChatCompletionMock.mockResolvedValueOnce("A helpful reply");
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", "ora-session=invalid-token")
      .send({ ...VALID_BODY, streamFallbackToken: "expired-jwt" });
    expect(res.status).toBe(200);
    // incrementMessageCount must be called (invalid token = fresh independent turn)
    expect(incrementMessageCountMock).toHaveBeenCalled();
    // acknowledgeStreamingIncrement must NOT be called (token verification failed)
    expect(acknowledgeStreamingIncrementMock).not.toHaveBeenCalled();
  });
}, 30000);

// ---------------------------------------------------------------------------
// Full token-flow end-to-end tests — verifies real SSE accumulation logic.
// ---------------------------------------------------------------------------

describe("POST /public-ai/chat/stream — full token flow", () => {
  beforeEach(() => {
    process.env.ORA_STREAMING_ENABLED = "true";
    validateSessionMock.mockReturnValue(FAKE_SESSION);
    markSessionAsPreIncrementedMock.mockReturnValue({
      token: "pre-incremented-token",
      payload: { msgCount: 1, imageCount: 0, streamingPreIncremented: true },
    });
    setSessionCookieMock.mockImplementation(() => undefined);

    // Default: createChatCompletion returns valid suggestions JSON.
    createChatCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              suggestions: [
                "What is React?",
                "How do I learn JavaScript?",
                "Tell me about TypeScript",
              ],
            }),
          },
        },
      ],
    });

    // Default streamChatCompletion: emit two token chunks immediately.
    streamChatCompletionMock.mockImplementation(async function* () {
      yield "Hello";
      yield " World";
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.ORA_STREAMING_ENABLED;
  });

  it("emits start → token events → done event with correct fields", async () => {
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const events = parseSSEEvents(res.text);

    // Must have a start event first
    const startEvent = events.find((e) => e.type === "start");
    expect(startEvent).toBeDefined();
    expect(events[0]?.type).toBe("start");

    // Must have token events
    const tokenEvents = events.filter((e) => e.type === "token");
    expect(tokenEvents.length).toBeGreaterThanOrEqual(1);
    expect(tokenEvents.every((e) => typeof e.text === "string")).toBe(true);

    // Accumulated text from tokens must match streamed content
    const accumulated = tokenEvents.map((e) => e.text as string).join("");
    expect(accumulated).toBe("Hello World");

    // Must end with a done event
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect(events[events.length - 1]?.type).toBe("done");

    // done payload must carry required fields
    const payload = doneEvent?.payload as Record<string, unknown>;
    expect(payload).toBeDefined();
    expect(typeof payload.msgCount).toBe("number");
    expect(typeof payload.msgLimit).toBe("number");
    expect(typeof payload.isRealStreaming).toBe("boolean");
    // openai provider → isRealStreaming must be true
    expect(payload.isRealStreaming).toBe(true);

    // reply must equal the trimmed accumulated text
    expect(payload.reply).toBe("Hello World");

    // mode must be a valid value
    expect(["instant", "deep"]).toContain(payload.mode);
  });

  it("populates the suggestions array in the done payload", async () => {
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send(VALID_BODY);

    expect(res.status).toBe(200);

    const events = parseSSEEvents(res.text);
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();

    const payload = doneEvent?.payload as Record<string, unknown>;
    expect(Array.isArray(payload.suggestions)).toBe(true);
    const suggestions = payload.suggestions as string[];
    expect(suggestions.length).toBeGreaterThan(0);
    suggestions.forEach((s) => expect(typeof s).toBe("string"));
  });

  it("done payload reflects pre-incremented session msgCount and correct msgLimit", async () => {
    // Pre-incremented payload has msgCount: 1; MSG_LIMIT_VALUE mock is 10.
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send(VALID_BODY);

    expect(res.status).toBe(200);

    const events = parseSSEEvents(res.text);
    const donePayload = (events.find((e) => e.type === "done")?.payload ?? {}) as Record<
      string,
      unknown
    >;

    // Anonymous session: msgCount comes from pre-incremented payload (1),
    // msgLimit comes from MSG_LIMIT_VALUE mock (10).
    expect(donePayload.msgCount).toBe(1);
    expect(donePayload.msgLimit).toBe(10);
  });

  it("mid-stream abort: client closing connection before done suppresses the done event", async () => {
    // This generator emits one token then pauses, giving the test time to
    // destroy the TCP socket so the server detects req "close" and aborts.
    streamChatCompletionMock.mockImplementation(async function* () {
      yield "Hello";
      await new Promise<void>((r) => setTimeout(r, 400));
      yield " World";
    });

    const app = await buildTestApp();

    await new Promise<void>((resolve, reject) => {
      const server = http.createServer(app as Parameters<typeof http.createServer>[1]);

      server.listen(0, () => {
        const addr = server.address() as { port: number };
        const receivedChunks: string[] = [];
        let socketDestroyed = false;

        const body = JSON.stringify(VALID_BODY);
        const clientReq = http.request({
          hostname: "127.0.0.1",
          port: addr.port,
          path: "/public-ai/chat/stream",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            Cookie: "ora-session=fake",
          },
        });

        const finish = (err?: Error) => {
          server.closeAllConnections?.();
          server.close(() => {
            if (err) reject(err);
            else resolve();
          });
        };

        // Safety timeout — prevent the test from hanging indefinitely.
        const safetyTimer = setTimeout(() => {
          finish(new Error("Abort test timed out after 8 s"));
        }, 8000);

        clientReq.on("response", (serverRes) => {
          serverRes.on("data", (chunk: Buffer) => {
            receivedChunks.push(chunk.toString());

            // Destroy the socket immediately after the first token event arrives.
            if (!socketDestroyed && receivedChunks.join("").includes("event: token")) {
              socketDestroyed = true;
              clientReq.destroy();

              // Wait long enough for the server to process the close event and
              // finish its loop before we check the accumulated SSE output.
              setTimeout(() => {
                clearTimeout(safetyTimer);
                const fullBody = receivedChunks.join("");
                try {
                  // The route must NOT emit a "done" event after an abort.
                  expect(fullBody, "done event must not be emitted after abort").not.toContain(
                    "event: done",
                  );
                  finish();
                } catch (e) {
                  finish(e as Error);
                }
              }, 700);
            }
          });
          serverRes.on("error", () => {});
        });

        clientReq.on("error", () => {});
        clientReq.write(body);
        clientReq.end();
      });

      server.on("error", (e) => reject(e));
    });
  }, 12000);
}, 30000);

// ---------------------------------------------------------------------------
// Full token-flow end-to-end tests — verifies real SSE accumulation logic.
// ---------------------------------------------------------------------------

describe("POST /public-ai/chat/stream — full token flow", () => {
  beforeEach(() => {
    process.env.ORA_STREAMING_ENABLED = "true";
    validateSessionMock.mockReturnValue(FAKE_SESSION);
    markSessionAsPreIncrementedMock.mockReturnValue({
      token: "pre-incremented-token",
      payload: { sessionId: "test-session-id", msgCount: 1, imageCount: 0 },
    });
    setSessionCookieMock.mockImplementation(() => undefined);

    // Default: createChatCompletion returns valid suggestions JSON.
    createChatCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              suggestions: [
                "What is React?",
                "How do I learn JavaScript?",
                "Tell me about TypeScript",
              ],
            }),
          },
        },
      ],
    });

    // Default streamChatCompletion: emit two token chunks immediately.
    streamChatCompletionMock.mockImplementation(async function* () {
      yield "Hello";
      yield " World";
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.ORA_STREAMING_ENABLED;
  });

  it("emits start → token events → done event with correct fields", async () => {
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const events = parseSSEEvents(res.text);

    // Must have a start event first
    const startEvent = events.find((e) => e.type === "start");
    expect(startEvent).toBeDefined();
    expect(events[0]?.type).toBe("start");

    // Must have token events
    const tokenEvents = events.filter((e) => e.type === "token");
    expect(tokenEvents.length).toBeGreaterThanOrEqual(1);
    expect(tokenEvents.every((e) => typeof e.text === "string")).toBe(true);

    // Accumulated text from tokens must match streamed content
    const accumulated = tokenEvents.map((e) => e.text as string).join("");
    expect(accumulated).toBe("Hello World");

    // Must end with a done event
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect(events[events.length - 1]?.type).toBe("done");

    // done payload must carry required fields
    const payload = doneEvent?.payload as Record<string, unknown>;
    expect(payload).toBeDefined();
    expect(typeof payload.msgCount).toBe("number");
    expect(typeof payload.msgLimit).toBe("number");
    expect(typeof payload.isRealStreaming).toBe("boolean");
    // openai provider → isRealStreaming must be true
    expect(payload.isRealStreaming).toBe(true);

    // reply must equal the trimmed accumulated text
    expect(payload.reply).toBe("Hello World");

    // mode must be a valid value
    expect(["instant", "deep"]).toContain(payload.mode);
  });

  it("populates the suggestions array in the done payload", async () => {
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send(VALID_BODY);

    expect(res.status).toBe(200);

    const events = parseSSEEvents(res.text);
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();

    const payload = doneEvent?.payload as Record<string, unknown>;
    expect(Array.isArray(payload.suggestions)).toBe(true);
    const suggestions = payload.suggestions as string[];
    expect(suggestions.length).toBeGreaterThan(0);
    suggestions.forEach((s) => expect(typeof s).toBe("string"));
  });

  it("done payload reflects pre-incremented session msgCount and correct msgLimit", async () => {
    // Pre-incremented payload has msgCount: 1; MSG_LIMIT_VALUE mock is 10.
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .set("Cookie", "ora-session=fake")
      .send(VALID_BODY);

    expect(res.status).toBe(200);

    const events = parseSSEEvents(res.text);
    const donePayload = (events.find((e) => e.type === "done")?.payload ?? {}) as Record<
      string,
      unknown
    >;

    // Anonymous session: msgCount comes from pre-incremented payload (1),
    // msgLimit comes from MSG_LIMIT_VALUE mock (10).
    expect(donePayload.msgCount).toBe(1);
    expect(donePayload.msgLimit).toBe(10);
  });

  it("mid-stream abort: client closing connection before done suppresses the done event", async () => {
    // This generator emits one token then pauses, giving the test time to
    // destroy the TCP socket so the server detects req "close" and aborts.
    streamChatCompletionMock.mockImplementation(async function* () {
      yield "Hello";
      await new Promise<void>((r) => setTimeout(r, 400));
      yield " World";
    });

    const app = await buildTestApp();

    await new Promise<void>((resolve, reject) => {
      const server = http.createServer(app as Parameters<typeof http.createServer>[1]);

      server.listen(0, () => {
        const addr = server.address() as { port: number };
        const receivedChunks: string[] = [];
        let socketDestroyed = false;

        const body = JSON.stringify(VALID_BODY);
        const clientReq = http.request({
          hostname: "127.0.0.1",
          port: addr.port,
          path: "/public-ai/chat/stream",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            Cookie: "ora-session=fake",
          },
        });

        const finish = (err?: Error) => {
          server.closeAllConnections?.();
          server.close(() => {
            if (err) reject(err);
            else resolve();
          });
        };

        // Safety timeout — prevent the test from hanging indefinitely.
        const safetyTimer = setTimeout(() => {
          finish(new Error("Abort test timed out after 8 s"));
        }, 8000);

        clientReq.on("response", (serverRes) => {
          serverRes.on("data", (chunk: Buffer) => {
            receivedChunks.push(chunk.toString());

            // Destroy the socket immediately after the first token event arrives.
            if (!socketDestroyed && receivedChunks.join("").includes("event: token")) {
              socketDestroyed = true;
              clientReq.destroy();

              // Wait long enough for the server to process the close event and
              // finish its loop before we check the accumulated SSE output.
              setTimeout(() => {
                clearTimeout(safetyTimer);
                const fullBody = receivedChunks.join("");
                try {
                  // The route must NOT emit a "done" event after an abort.
                  expect(fullBody, "done event must not be emitted after abort").not.toContain(
                    "event: done",
                  );
                  finish();
                } catch (e) {
                  finish(e as Error);
                }
              }, 700);
            }
          });
          serverRes.on("error", () => {});
        });

        clientReq.on("error", () => {});
        clientReq.write(body);
        clientReq.end();
      });

      server.on("error", (e) => reject(e));
    });
  }, 12000);

  // ── Promise guards: void catch() on early-exit promises ──────────────────

  it("structural: chat.ts has void catch guards on classifierPromise before any early-exit", async () => {
    // This guard prevents unhandled promise rejections when a 429, spend-cap,
    // or other early-exit path returns before `await classifierPromise` is
    // reached. classifyIntent fires in parallel with auth, so it is always
    // in-flight when early exits happen.
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../chat.ts"), "utf8");
    expect(src).toContain("void classifierPromise.catch(() => undefined)");
  });

  it("structural: chat.ts has void catch guards on early-context promises", async () => {
    // earlyMemoryP and earlyProfileP are started right after auth resolves.
    // A 429 (authed message limit) or spend-cap early-exit fires before the
    // Promise.all that awaits them — the guards prevent unhandled rejections.
    // buildCrossConversationContext is called inline in the Promise.all (not as
    // an early background promise) so it does not need a separate catch guard.
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../chat.ts"), "utf8");
    expect(src).toContain("void earlyMemoryP.catch(() => undefined)");
    expect(src).toContain("void earlyProfileP.catch(() => undefined)");
    // Cross-conv context runs inline in Promise.all — no early background promise.
    expect(src).not.toContain("void earlyCrossConvP.catch(() => undefined)");
  });

  it("structural: billing.ts has evictTierCache calls after every subscription mutation", async () => {
    // Tier cache must be evicted synchronously after every DB write that changes
    // a subscription — otherwise the stale in-process cache serves the old tier
    // for up to 60 seconds after a Stripe webhook fires.
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../../billing.ts"), "utf8");
    // Must be >=5: checkout, invoice.paid, payment_failed (x2 branches),
    // subscription.updated, subscription.deleted.
    const matches = src.match(/evictTierCache\(/g) ?? [];
    expect(
      matches.length,
      "billing.ts must call evictTierCache at >=5 mutation sites",
    ).toBeGreaterThanOrEqual(5);
  });
}, 30000);
