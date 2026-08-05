/**
 * Integration test - verified-or-fail live-search contract through the Ora chat route.
 *
 * When live web search fails, times out, or returns prose without citations, Ora
 * must not degrade into uncited speculative bullets. The route returns a
 * retryable 503, refunds the consumed turn exactly once, and the client can show
 * a Retry live search affordance. The general model fallback is intentionally
 * mocked and asserted unused.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";
// Resolves to the mocked class from vi.mock("openai") below, so `new
// APIConnectionTimeoutError()` in a test is instanceof the same class
// web-search.ts checks against when deciding whether to retry on timeout.
import { APIConnectionTimeoutError } from "openai";

const TEST_SECRET = "search-failure-test-secret";
const RETRYABLE_ERROR_FRAGMENT = "verified live web results";

// Mock the OpenAI SDK so the web_search Responses call can be controlled per test.
const createMock = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({
  default: class {
    responses = { create: createMock };
  },
  APIConnectionTimeoutError: class extends Error {},
}));

// The old live-search failure path called this provider fallback. Item 3 forbids
// that: a search attempt must return cited live results or fail cleanly.
const createChatCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/ai-providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/ai-providers")>();
  return { ...actual, createChatCompletion: createChatCompletionMock };
});

vi.mock("../../../lib/public-ai/authed-user", () => ({
  PAID_TIERS: new Set(["core", "wave"]),
  resolveAuthedOraUser: vi.fn(async () => ({
    userId: "test-user",
    tier: "core",
    isPaid: true,
  })),
}));

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
vi.mock("../../../../../../lib/db/src/index.ts", () => {
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
    sessionId: "search-failure-session-" + Math.random().toString(36).slice(2),
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
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder";
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  const router = (await import("../chat")).default;
  app.use(router);
  return app;
}

function postChat(app: express.Express, message: string, extraBody: Record<string, unknown> = {}) {
  const { token } = makeSession();
  return request(app)
    .post("/public-ai/chat")
    .set("Cookie", `ora-session=${token}`)
    .send({
      message,
      mode: "deep",
      messages: [],
      referenceSavedMemories: false,
      ...extraBody,
    });
}

function expectRetryableSearchFailure(res: request.Response) {
  expect(res.status).toBe(503);
  expect(res.body.searchRetryable).toBe(true);
  expect(res.body.searchFallback).toBeUndefined();
  expect(res.body.reply).toBeUndefined();
  expect(res.body.error).toContain(RETRYABLE_ERROR_FRAGMENT);
  expect(res.body.activity).toEqual([
    expect.objectContaining({ tool: "web-search", phase: "fail" }),
  ]);
  expect(refundOraQuotaMock).toHaveBeenCalledTimes(1);
  expect(createChatCompletionMock).not.toHaveBeenCalled();
}

describe("POST /public-ai/chat - verified-or-fail when live web search fails", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.resetAllMocks();
    createMock.mockRejectedValue(new Error("web_search upstream failed"));
    app = await buildApp();
  });

  it("returns retryable 503 and refunds when search fails on a current-info query", async () => {
    const res = await postChat(app, "what is the current bitcoin price");

    expect(createMock).toHaveBeenCalled();
    expectRetryableSearchFailure(res);
  });

  it("returns retryable 503 and refunds when a normal search attempt times out", async () => {
    createMock.mockRejectedValue(new APIConnectionTimeoutError({ message: "timed out" }));

    const res = await postChat(app, "what is the current bitcoin price");

    expect(createMock).toHaveBeenCalledTimes(1);
    expectRetryableSearchFailure(res);
  });

  it("forceSearch pins a non-search message to live web search without model fallback", async () => {
    const res = await postChat(app, "hello there, how are you", { forceSearch: true });

    expect(createMock).toHaveBeenCalled();
    expectRetryableSearchFailure(res);
  });

  it("forced search runs the harder secondary attempt when the provider times out", async () => {
    createMock.mockRejectedValue(new APIConnectionTimeoutError({ message: "timed out" }));

    const res = await postChat(app, "what is the current bitcoin price", { forceSearch: true });

    expect(createMock).toHaveBeenCalledTimes(2);
    expectRetryableSearchFailure(res);
  });

  it("does not answer from general knowledge for evergreen search failures", async () => {
    const res = await postChat(app, "search the web for the history of the eiffel tower");

    expect(createMock).toHaveBeenCalled();
    expectRetryableSearchFailure(res);
  });

  it("rejects a provider answer that has prose but no citations", async () => {
    createMock.mockResolvedValueOnce({
      output_text: "Here is an uncited search-looking answer.",
      output: [],
    });

    const res = await postChat(app, "search the web for the latest Ora product news");

    expect(createMock).toHaveBeenCalledTimes(1);
    expectRetryableSearchFailure(res);
  });
});
