/**
 * Integration test — image cards end-to-end through the Ora chat route.
 *
 * Covers the full request path the unit tests miss:
 *   POST /public-ai/chat  →  orchestrator routes a web-search message to the
 *   `search` tool  →  runOraWebSearch calls the OpenAI Responses API  →
 *   parseOraMediaBlock + sanitizeImages extract the trailing ora-media block  →
 *   the route returns a populated, URL-safe `images` array that the UI renders
 *   as inline image cards.
 *
 * Mirrors the videos coverage (search-video-cards.test.ts). Note that the image
 * path has no dedicated "wantsImages" directive — real images simply surface in
 * the ora-media block of any web search — so the trigger here is a plain
 * web-search message (a "show me a picture" phrasing would route to image
 * GENERATION instead, a different pipeline).
 *
 * The OpenAI Responses API is mocked at the SDK boundary (not at
 * runOraWebSearch), so the real prompt → parse → sanitize → response pipeline
 * runs. This test is deterministic and always runs in CI; a companion gated
 * live test (search-image-cards.live.test.ts) exercises the same path against
 * the real provider when OPENAI_API_KEY is present.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";
import { isSafeHttpUrl } from "../../../lib/public-ai/web-search";

const TEST_SECRET = "search-image-cards-test-secret";

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock the OpenAI SDK so responses.create returns a deterministic reply that
// carries a trailing ora-media block with two safe image URLs and one unsafe
// (loopback) URL. The route's real sanitizeImages must keep the first two and
// drop the third.
const createMock = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({
  default: class {
    responses = { create: createMock };
  },
}));

// Search requires a signed-in user (checkToolAccess denies anonymous with
// search_signin_required). Mock the resolver to return a free authed user.
vi.mock("../../../lib/public-ai/authed-user", () => ({
  PAID_TIERS: new Set(["core", "wave"]),
  resolveAuthedOraUser: vi.fn(async () => ({
    userId: "test-user",
    tier: "free",
    isPaid: false,
  })),
}));

// Ora quota metering — always allow; report a benign usage snapshot.
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

// The chat route imports the real `db` + tables for profile/memory context.
// Mock @workspace/db so no Postgres connection is opened: db is a chainable
// thenable that resolves to [] (no profile, no memories), and the table stubs
// expose any column accessed by the drizzle helpers.
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
    sessionId: "image-card-session-" + Math.random().toString(36).slice(2),
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

function outputWithCitation(): unknown[] {
  return [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "answer body",
          annotations: [
            {
              type: "url_citation",
              url: "https://example.com/search-source",
              title: "Search Source",
            },
          ],
        },
      ],
    },
  ];
}

describe("POST /public-ai/chat — image cards via live web search (mocked provider)", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    createMock.mockReset();
    app = await buildApp();
  });

  it("returns a non-empty, URL-safe images array for a web-search request", async () => {
    createMock.mockResolvedValueOnce({
      output_text:
        "Here are a couple of relevant pictures I found.\n\n```ora-media\n" +
        JSON.stringify({
          images: [
            {
              url: "https://upload.wikimedia.org/eiffel.jpg",
              title: "Eiffel Tower",
              source: "https://en.wikipedia.org/wiki/Eiffel_Tower",
            },
            { url: "https://cdn.example.com/paris.png", title: "Paris skyline" },
            // Unsafe loopback URL — must be stripped by sanitizeImages.
            { url: "http://127.0.0.1/internal.jpg", title: "evil" },
          ],
          videos: [],
        }) +
        "\n```",
      output: outputWithCitation(),
    });

    const { token } = makeSession();
    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${token}`)
      .send({
        message: "search the web for the eiffel tower",
        messages: [],
        // Skip the saved-memory DB read path; profile context still runs.
        referenceSavedMemories: false,
      });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.images)).toBe(true);
    // Both safe URLs survive; the loopback URL is dropped.
    expect(res.body.images.length).toBe(2);
    expect(res.body.images.every((i: { url: string }) => isSafeHttpUrl(i.url))).toBe(true);
    expect(res.body.images.some((i: { url: string }) => i.url.includes("127.0.0.1"))).toBe(false);
    // The page each image was found on is preserved when it is itself safe.
    expect(res.body.images[0].source).toContain("en.wikipedia.org");
    // The trailing ora-media block must be stripped from the visible reply.
    expect(typeof res.body.reply).toBe("string");
    expect(res.body.reply).not.toContain("ora-media");

    // The model received the media directive that asks for an images array.
    expect(createMock).toHaveBeenCalledTimes(1);
    const arg = createMock.mock.calls[0][0] as { instructions: string };
    expect(arg.instructions).toContain("ora-media");
    expect(arg.instructions).toContain('"images"');
  });

  it("drops every image when the provider returns only unsafe URLs", async () => {
    createMock.mockResolvedValueOnce({
      output_text:
        "Here you go.\n\n```ora-media\n" +
        JSON.stringify({
          images: [
            { url: "http://10.0.0.5/private.jpg", title: "private" },
            { url: "javascript:alert(1)", title: "xss" },
            { url: "file:///etc/passwd", title: "local" },
          ],
          videos: [],
        }) +
        "\n```",
      output: outputWithCitation(),
    });

    const { token } = makeSession();
    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${token}`)
      .send({
        message: "look up the eiffel tower online",
        messages: [],
        referenceSavedMemories: false,
      });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.images)).toBe(true);
    expect(res.body.images.length).toBe(0);
  });
});
