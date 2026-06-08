/**
 * Gated LIVE integration test — video cards end-to-end with a real web search.
 *
 * Sends a "find a video about X" message through the real chat route, which runs
 * a real OpenAI Responses API web_search call (no SDK mock here) and asserts the
 * response includes a non-empty, URL-safe `videos` array that renders as cards.
 *
 * Skippable when no API key is present: the whole suite is gated on
 * OPENAI_API_KEY via describe.runIf, matching the gated-test pattern (the
 * deterministic CI coverage lives in search-video-cards.test.ts). It is
 * additionally gated on ORA_LIVE_SEARCH_TEST so it never makes a paid/networked
 * call during a normal `vitest run` unless explicitly opted in.
 *
 * Note: the model is non-deterministic; this is a best-effort live smoke test.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";
import { isSafeHttpUrl } from "../../../lib/public-ai/web-search";

const TEST_SECRET = "search-video-cards-live-secret";
const LIVE_ENABLED = Boolean(process.env.OPENAI_API_KEY && process.env.ORA_LIVE_SEARCH_TEST);

// Authed user so the search tool is allowed (anonymous is denied).
vi.mock("../../../lib/public-ai/authed-user", () => ({
  PAID_TIERS: new Set(["core", "wave"]),
  resolveAuthedOraUser: vi.fn(async () => ({ userId: "live-user", tier: "free", isPaid: false })),
}));

// Quota metering — always allow.
vi.mock("../../../lib/public-ai/ora-usage", () => ({
  consumeOraQuota: vi.fn(async () => ({
    allowed: true,
    used: 1,
    limit: 100,
    kind: "message",
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

// Avoid any Postgres connection for profile/memory context.
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

function makeSession() {
  const payload = {
    sessionId: "live-video-session-" + Math.random().toString(36).slice(2),
    msgCount: 0,
    fileCount: 0,
    imageCount: 0,
    imageAnalysisCount: 0,
    createdAt: Date.now(),
  };
  return jwt.sign(payload, TEST_SECRET, { expiresIn: "30m" });
}

async function buildApp() {
  process.env.ORA_SESSION_SECRET = TEST_SECRET;
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  const router = (await import("../chat")).default;
  app.use(router);
  return app;
}

describe.runIf(LIVE_ENABLED)("POST /public-ai/chat — LIVE video cards web search", () => {
  let app: express.Express;

  beforeEach(async () => {
    app = await buildApp();
  });

  it("returns a non-empty, URL-safe videos array from a real web search", async () => {
    const token = makeSession();
    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${token}`)
      .send({
        message: "find me a youtube video about how to tie a tie",
        messages: [],
        referenceSavedMemories: false,
      });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.videos)).toBe(true);
    expect(res.body.videos.length).toBeGreaterThan(0);
    expect(res.body.videos.every((v: { url: string }) => isSafeHttpUrl(v.url))).toBe(true);
  }, 60_000);
});
