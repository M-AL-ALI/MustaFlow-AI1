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

vi.mock("../../../lib/public-ai/session", () => ({
  createSessionToken: createSessionTokenMock,
  validateSession: validateSessionMock,
  incrementMessageCount: incrementMessageCountMock,
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
  selectOraModelRoute: vi.fn().mockReturnValue([{ provider: "openai", model: "gpt-5-mini" }]),
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
};

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
    const res = await request(app)
      .post("/public-ai/chat/stream")
      .send(VALID_BODY);
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
      path.resolve(__dirname, "../stream-adapter.ts"),
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
