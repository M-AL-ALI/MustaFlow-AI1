/**
 * Integration test — graceful web-search FAILURE fallback through the Ora chat route.
 *
 * This locks in the Deep-mode QA blocker fix: when a live web search fails or
 * times out, the route must NOT leave the user with a dead "Web search failed"
 * banner. Instead it answers from the model's own knowledge with an honest
 * caveat, keeps the turn's quota consumed (an answer WAS delivered), and only
 * refunds + returns a retryable 503 if the fallback answer ALSO fails.
 *
 * Covered end-to-end through POST /public-ai/chat:
 *   1. search fails → fallback answer succeeds → 200 with SEARCH_FALLBACK_NOTE,
 *      searchFallback:true, searchRetryable per freshness, quota NOT refunded.
 *   2. search fails → fallback answer also fails → 503 searchRetryable:true,
 *      quota refunded exactly once.
 *   3. search fails → fallback answer empty → treated as a failure (503 + refund).
 *   4. an evergreen search that fails → searchFallback:true but searchRetryable
 *      is false (a general-knowledge answer is not stale for evergreen topics).
 *
 * The provider boundary is mocked: the OpenAI Responses API (web search) always
 * rejects, and ai-providers.createChatCompletion (the fallback chain) is
 * controlled per test. The real orchestrator → runOraWebSearch → route fallback
 * pipeline runs, so this is deterministic and always runs in CI.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";

const TEST_SECRET = "search-fallback-test-secret";

// The honest degradation note the route prepends (mirrors SEARCH_FALLBACK_NOTE
// in chat.ts, which is module-local and not exported).
const FALLBACK_NOTE_FRAGMENT = "answering from general knowledge";

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock the OpenAI SDK so the web_search Responses call ALWAYS rejects — every
// attempt (initial + capped retry) fails, so runOraWebSearch throws and the
// route's graceful-degradation catch takes over.
const createMock = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({
  default: class {
    responses = { create: createMock };
  },
}));

// Control the general-knowledge fallback chain. runCandidateChain invokes this
// per candidate; the real selectOraModelRoute/runCandidateChain still run.
const createChatCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/ai-providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/ai-providers")>();
  return { ...actual, createChatCompletion: createChatCompletionMock };
});

// Search requires a signed-in user; Deep fallback requires a PAID user, so
// resolve a Core-tier account.
vi.mock("../../../lib/public-ai/authed-user", () => ({
  PAID_TIERS: new Set(["core", "wave"]),
  resolveAuthedOraUser: vi.fn(async () => ({
    userId: "test-user",
    tier: "core",
    isPaid: true,
  })),
}));

// Ora quota metering — allow the turn; spy on refundOraQuota so we can assert
// the refund semantics (kept on fallback success, refunded on double failure).
const refundOraQuotaMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../../lib/public-ai/ora-usage", () => ({
  consumeOraQuota: vi.fn(async () => ({
    allowed: true,
    used: 1,
    limit: 1000,
    kind: "message",
    resetsAt: null,
  })),
  refundOraQuota: refundOraQuotaMock,
  getOraUsage: vi.fn(async () => ({
    messageCount: 1,
    imageCount: 0,
    messageLimit: 1000,
    imageLimit: 50,
    windowHours: 24,
    windowStart: null,
    resetsAt: null,
  })),
}));

// Mock @workspace/db so no Postgres connection is opened; profile/memory reads
// resolve to [] (no personal context).
vi.mock("@workspace/db", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "orderBy", "limit"]) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (v: unknown[]) => unknown) => resolve([]);
  const tableStub = new Proxy({}, { get: (_t, prop) => ({ name: String(prop) }) }) as Record<
    string,
    unknown
  >;
  return {
    db: chain,
    knowledgeEntriesTable: tableStub,
    oraProfilesTable: tableStub,
    generatedImagesTable: tableStub,
    TIER_ORA_MESSAGE_LIMIT: { free: 100, core: 1000, wave: 5000 },
  };
});

function makeSession(overrides: Record<string, unknown> = {}) {
  const payload = {
    sessionId: "fallback-session-" + Math.random().toString(36).slice(2),
    msgCount: 0,
    fileCount: 0,
    imageCount: 0,
    imageAnalysisCount: 0,
    createdAt: Date.now(),
    ...overrides,
  };
  const token = jwt.sign(payload, TEST_SECRET, { expiresIn: "30m" });
  return { token, payload };
}

async function buildApp() {
  process.env.ORA_SESSION_SECRET = TEST_SECRET;
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-key";
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  const router = (await import("../chat")).default;
  app.use(router);
  return app;
}

function postChat(app: express.Express, message: string) {
  const { token } = makeSession();
  return request(app)
    .post("/public-ai/chat")
    .set("Cookie", `ora-session=${token}`)
    .send({ message, mode: "deep", messages: [], referenceSavedMemories: false });
}

describe("POST /public-ai/chat — graceful fallback when live web search fails", () => {
  let app: express.Express;

  beforeEach(async () => {
    // resetAllMocks (not clearAllMocks) so any unconsumed mock*Once queue never
    // leaks into the next test.
    vi.resetAllMocks();
    // Re-apply the always-reject default for the web-search provider.
    createMock.mockRejectedValue(new Error("web_search upstream timeout"));
    app = await buildApp();
  });

  it("answers from general knowledge (no refund) when search fails on a current-info query", async () => {
    createChatCompletionMock.mockResolvedValue({
      choices: [{ message: { content: "Bitcoin is a decentralized digital currency." } }],
    });

    const res = await postChat(app, "what is the current bitcoin price");

    expect(res.status).toBe(200);
    expect(res.body.searchFallback).toBe(true);
    // Honest degradation note is prepended to the reply.
    expect(res.body.reply).toContain(FALLBACK_NOTE_FRAGMENT);
    expect(res.body.reply).toContain("Bitcoin is a decentralized digital currency.");
    // A volatile/current query is worth a live-verification retry.
    expect(res.body.searchRetryable).toBe(true);
    // An answer WAS delivered, so the quota stays consumed.
    expect(refundOraQuotaMock).not.toHaveBeenCalled();
    // The web-search provider was actually attempted (and failed) first.
    expect(createMock).toHaveBeenCalled();
  });

  it("returns searchRetryable:false for an evergreen search that degrades", async () => {
    createChatCompletionMock.mockResolvedValue({
      choices: [{ message: { content: "The Eiffel Tower was completed in 1889." } }],
    });

    const res = await postChat(app, "search the web for the history of the eiffel tower");

    expect(res.status).toBe(200);
    expect(res.body.searchFallback).toBe(true);
    expect(res.body.reply).toContain(FALLBACK_NOTE_FRAGMENT);
    // Evergreen background does not need a live-verification retry affordance.
    expect(res.body.searchRetryable).toBe(false);
    expect(refundOraQuotaMock).not.toHaveBeenCalled();
  });

  it("refunds the quota and returns a retryable 503 when the fallback answer also fails", async () => {
    createChatCompletionMock.mockRejectedValue(new Error("all providers down"));

    const res = await postChat(app, "what is the current bitcoin price");

    expect(res.status).toBe(503);
    expect(res.body.searchRetryable).toBe(true);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.length).toBeGreaterThan(0);
    // No answer was delivered, so the turn's quota is refunded exactly once.
    expect(refundOraQuotaMock).toHaveBeenCalledTimes(1);
  });

  it("treats an EMPTY fallback answer as a failure (refund + retryable 503)", async () => {
    createChatCompletionMock.mockResolvedValue({
      choices: [{ message: { content: "   " } }],
    });

    const res = await postChat(app, "what is the current bitcoin price");

    expect(res.status).toBe(503);
    expect(res.body.searchRetryable).toBe(true);
    expect(refundOraQuotaMock).toHaveBeenCalledTimes(1);
  });
});
