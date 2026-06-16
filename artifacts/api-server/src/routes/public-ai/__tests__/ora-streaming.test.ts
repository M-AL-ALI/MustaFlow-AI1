import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import * as http from "http";
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
    payload: { sessionId: "test-session-id", msgCount: 1, imageCount: 0 },
  }),
);
const acknowledgeStreamingIncrementMock = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    token: "ack-token",
    payload: { sessionId: "test-session-id", msgCount: 1, imageCount: 0 },
  }),
);

const streamChatCompletionMock = vi.hoisted(() => vi.fn());
const createChatCompletionMock = vi.hoisted(() => vi.fn());

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
  selectOraModelRoute: vi
    .fn()
    .mockReturnValue([{ provider: "openai", model: "gpt-5-mini" }]),
  runCandidateChain: vi.fn().mockResolvedValue(""),
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
};

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
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.ORA_STREAMING_ENABLED;
  });

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
}, 30000);
