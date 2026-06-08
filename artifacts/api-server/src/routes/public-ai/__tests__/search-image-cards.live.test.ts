/**
 * Gated LIVE integration test — image cards end-to-end with a real web search.
 *
 * Sends a web-search message through the real chat route, which runs a real
 * OpenAI Responses API web_search call (no SDK mock here) and asserts the
 * response includes a URL-safe `images` array that renders as inline cards.
 *
 * The model is non-deterministic and may legitimately decide a query needs no
 * images, so this asserts the array is present and every URL is safe (it does
 * NOT require a non-empty array) — a best-effort live smoke test mirroring the
 * videos coverage (search-video-cards.live.test.ts).
 *
 * Skippable when no API key is present: the whole suite is gated on
 * OPENAI_API_KEY via describe.runIf (the deterministic CI coverage lives in
 * search-image-cards.test.ts). It is additionally gated on ORA_LIVE_SEARCH_TEST
 * so it never makes a paid/networked call during a normal `vitest run` unless
 * explicitly opted in.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";
import { isSafeHttpUrl } from "../../../lib/public-ai/web-search";

const TEST_SECRET = "search-image-cards-live-secret";
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
    sessionId: "live-image-session-" + Math.random().toString(36).slice(2),
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

describe.runIf(LIVE_ENABLED)("POST /public-ai/chat — LIVE image cards web search", () => {
  let app: express.Express;

  beforeEach(async () => {
    app = await buildApp();
  });

  it("returns a URL-safe images array from a real web search", async () => {
    const token = makeSession();
    // Phrasing matters: a "photos of X" / "show me a picture" message would route
    // to the image-GENERATION pipeline (ORA_IMAGE_PATTERNS) before reaching
    // search. This prompt forces the web-search branch instead, where real
    // images surface in the ora-media block.
    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${token}`)
      .send({
        message: "search the web for information and image links about the Eiffel Tower in Paris",
        messages: [],
        referenceSavedMemories: false,
      });

    expect(res.status).toBe(200);
    // We exercised the search path, not image generation: no generated imageUrl,
    // and the visible reply never leaks the trailing ora-media block.
    expect(res.body.imageUrl).toBeUndefined();
    expect(typeof res.body.reply).toBe("string");
    expect(res.body.reply).not.toContain("ora-media");
    expect(Array.isArray(res.body.images)).toBe(true);
    expect(res.body.images.every((i: { url: string }) => isSafeHttpUrl(i.url))).toBe(true);
  }, 60_000);
});
