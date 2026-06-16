import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

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
      preIncrementedAt: Date.now(),
    },
  }),
);
const acknowledgeStreamingIncrementMock = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    token: "acknowledged-token",
    payload: { msgCount: 1, imageCount: 0 },
  }),
);

// streamChatCompletion mock: yields two token deltas then returns.
const streamChatCompletionMock = vi.hoisted(() =>
  vi.fn(async function* () {
    yield " Hello";
    yield " World";
  }),
);
const createChatCompletionMock = vi.hoisted(() => vi.fn().mockResolvedValue(""));

vi.mock("../../../lib/public-ai/session", () => ({
  createSessionToken: createSessionTokenMock,
  validateSession: validateSessionMock,
  incrementMessageCount: incrementMessageCountMock,
  setSessionCookie: setSessionCookieMock,
  isOraSecretConfigured: isOraSecretConfiguredMock,
  markSessionAsPreIncremented: markSessionAsPreIncrementedMock,
  acknowledgeStreamingIncrement: acknowledgeStreamingIncrementMock,
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
  buildCarriedDocumentContext: vi.fn().mockReturnValue(""),
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
// Tests
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
    const errorBlockStart = src.indexOf("if (streamError || !streamedReply.trim())");
    expect(errorBlockStart).toBeGreaterThan(0);
    const errorBlock = src.slice(errorBlockStart, errorBlockStart + 600);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    streamChatCompletionMock.mockImplementationOnce(async function* () {
      yield " partial";
      throw new Error("provider cut stream");
    } as any);
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

  // ── chargeSession / isStreamingFallback ───────────────────────────────────

  // The next two tests exercise the non-streaming /chat route to verify
  // chargeSession correctly guards acknowledgeStreamingIncrement behind the
  // explicit isStreamingFallback client signal — preventing a stale
  // streamingPreIncremented cookie from silently undercharging an independent turn.

  it("/chat without isStreamingFallback: uses incrementMessageCount even with stale streamingPreIncremented", async () => {
    // Simulate the failure scenario: a successful streaming turn left a stale
    // streamingPreIncremented: true cookie. The NEXT user message (a fresh
    // turn, not a streaming retry) must still be charged normally.
    validateSessionMock.mockReturnValue({
      ...FAKE_SESSION,
      streamingPreIncremented: true as const,
      preIncrementedAt: Date.now() - 5_000,
      msgCount: 1,
    });
    createChatCompletionMock.mockResolvedValueOnce("A helpful reply");
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", "ora-session=stale-flag")
      .send(VALID_BODY); // no isStreamingFallback → defaults false
    expect(res.status).toBe(200);
    // incrementMessageCount must be called (normal charge)
    expect(incrementMessageCountMock).toHaveBeenCalled();
    // acknowledgeStreamingIncrement must NOT be called (stale flag ignored)
    expect(acknowledgeStreamingIncrementMock).not.toHaveBeenCalled();
  });

  it("/chat with isStreamingFallback:true + streamingPreIncremented: acknowledges without double-charging", async () => {
    // Simulate the intended scenario: streaming pre-incremented the session but
    // failed before the first token; client retries via /chat with the flag.
    validateSessionMock.mockReturnValue({
      ...FAKE_SESSION,
      streamingPreIncremented: true as const,
      preIncrementedAt: Date.now() - 5_000, // 5 s ago — well within the 60 s TTL
      msgCount: 1,
    });
    createChatCompletionMock.mockResolvedValueOnce("A helpful reply");
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", "ora-session=pre-incremented")
      .send({ ...VALID_BODY, isStreamingFallback: true });
    expect(res.status).toBe(200);
    // acknowledgeStreamingIncrement must be called (clear flag, no extra increment)
    expect(acknowledgeStreamingIncrementMock).toHaveBeenCalled();
    // incrementMessageCount must NOT be called (would be a double-charge)
    expect(incrementMessageCountMock).not.toHaveBeenCalled();
  });

  it("/chat with isStreamingFallback:true + STALE preIncrementedAt: falls through to incrementMessageCount", async () => {
    // Regression: a successful streaming turn left streamingPreIncremented: true
    // in the cookie, but the pre-increment is older than the TTL window. A later
    // request claiming isStreamingFallback:true must still be charged normally —
    // the server must not honour a stale flag regardless of the client assertion.
    validateSessionMock.mockReturnValue({
      ...FAKE_SESSION,
      streamingPreIncremented: true as const,
      preIncrementedAt: Date.now() - 90_000, // 90 s ago — outside the 60 s TTL
      msgCount: 1,
    });
    createChatCompletionMock.mockResolvedValueOnce("A helpful reply");
    const app = await buildTestApp();
    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", "ora-session=stale-pre-increment")
      .send({ ...VALID_BODY, isStreamingFallback: true });
    expect(res.status).toBe(200);
    // incrementMessageCount must be called (stale pre-increment = fresh independent turn)
    expect(incrementMessageCountMock).toHaveBeenCalled();
    // acknowledgeStreamingIncrement must NOT be called (TTL expired)
    expect(acknowledgeStreamingIncrementMock).not.toHaveBeenCalled();
  });
}, 30000);
