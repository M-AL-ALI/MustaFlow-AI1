/**
 * Integration test — video cards end-to-end through the Ora chat route.
 *
 * Covers the full request path the unit tests miss:
 *   POST /public-ai/chat  →  orchestrator routes a "show me a video about X"
 *   message to the `search` tool with wantsVideos  →  runOraWebSearch calls the
 *   OpenAI Responses API  →  parseOraMediaBlock + sanitizeVideos extract the
 *   trailing ora-media block  →  the route returns a populated, URL-safe
 *   `videos` array that the UI renders as clickable cards.
 *
 * The OpenAI Responses API is mocked at the SDK boundary (not at
 * runOraWebSearch), so the real prompt → parse → sanitize → response pipeline
 * runs. This test is deterministic and always runs in CI; a companion gated
 * live test (search-video-cards.live.test.ts) exercises the same path against
 * the real provider when OPENAI_API_KEY is present.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";
import { isSafeHttpUrl } from "../../../lib/public-ai/web-search";

const TEST_SECRET = "search-video-cards-test-secret";

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock the OpenAI SDK so responses.create returns a deterministic reply that
// carries a trailing ora-media block with one safe YouTube video and one unsafe
// (loopback) URL. The route's real sanitizeVideos must keep the first and drop
// the second.
const createMock = vi.fn();
vi.mock("openai", () => ({
  default: class {
    responses = { create: createMock };
  },
}));

// verifyVideos() confirms each model-reported video via the provider's public
// oEmbed endpoint before it is surfaced. Stub fetch so the deterministic test
// never touches the network: a YouTube oEmbed lookup resolves 200 with
// metadata, except the sentinel id "doesnotexist" which 404s (a hallucinated
// video). Anything else 404s too.
const fetchMock = vi.fn(async (input: unknown) => {
  const url = String(input);
  if (url.startsWith("https://www.youtube.com/oembed")) {
    if (url.includes("doesnotexist")) {
      return new Response("not found", { status: 404 });
    }
    return new Response(
      JSON.stringify({ title: "Verified", thumbnail_url: "https://img.youtube.com/x.jpg" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response("not found", { status: 404 });
});

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
    sessionId: "video-card-session-" + Math.random().toString(36).slice(2),
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

describe("POST /public-ai/chat — video cards via live web search (mocked provider)", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    createMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    app = await buildApp();
  });

  it("returns a non-empty, URL-safe videos array for a video-find request", async () => {
    createMock.mockResolvedValueOnce({
      output_text:
        "Here are a couple of helpful videos.\n\n```ora-media\n" +
        JSON.stringify({
          images: [],
          videos: [
            { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "How to tie a tie" },
            { url: "https://youtu.be/9bZkp7q19f0", title: "Another tutorial" },
            // Unsafe loopback URL — must be stripped by sanitizeVideos.
            { url: "http://127.0.0.1/internal", title: "evil" },
          ],
        }) +
        "\n```",
      output: [],
    });

    const { token } = makeSession();
    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${token}`)
      .send({
        message: "show me a video about how to tie a tie",
        messages: [],
        // Skip the saved-memory DB read path; profile context still runs.
        referenceSavedMemories: false,
      });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.videos)).toBe(true);
    // Both safe YouTube URLs survive; the loopback URL is dropped.
    expect(res.body.videos.length).toBe(2);
    expect(res.body.videos.every((v: { url: string }) => isSafeHttpUrl(v.url))).toBe(true);
    expect(res.body.videos.some((v: { url: string }) => v.url.includes("127.0.0.1"))).toBe(false);
    // YouTube links get a derived thumbnail so the card shows a preview.
    expect(
      res.body.videos.every((v: { thumbnailUrl?: string }) =>
        (v.thumbnailUrl ?? "").includes("img.youtube.com"),
      ),
    ).toBe(true);
    // The trailing ora-media block must be stripped from the visible reply.
    expect(typeof res.body.reply).toBe("string");
    expect(res.body.reply).not.toContain("ora-media");

    // The model received the video-specific directive (wantsVideos threaded).
    expect(createMock).toHaveBeenCalledTimes(1);
    const arg = createMock.mock.calls[0][0] as { instructions: string };
    expect(arg.instructions).toContain("specifically asking for a video");
  });

  it("drops every video when the provider returns only unsafe URLs", async () => {
    createMock.mockResolvedValueOnce({
      output_text:
        "Here you go.\n\n```ora-media\n" +
        JSON.stringify({
          images: [],
          videos: [
            { url: "http://10.0.0.5/clip", title: "private" },
            { url: "javascript:alert(1)", title: "xss" },
            { url: "file:///etc/passwd", title: "local" },
          ],
        }) +
        "\n```",
      output: [],
    });

    const { token } = makeSession();
    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${token}`)
      .send({
        message: "find me a youtube video on sourdough",
        messages: [],
        referenceSavedMemories: false,
      });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.videos)).toBe(true);
    expect(res.body.videos.length).toBe(0);
  });

  it("drops a well-formed YouTube URL whose video does not exist (oEmbed 404)", async () => {
    createMock.mockResolvedValueOnce({
      output_text:
        "Here you go.\n\n```ora-media\n" +
        JSON.stringify({
          images: [],
          videos: [
            // URL-shape valid but the video is gone — oEmbed 404s, so the card
            // would otherwise render as a broken player + dead link.
            { url: "https://www.youtube.com/watch?v=doesnotexist", title: "fake" },
            // A real, verifiable video alongside it survives.
            { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "real" },
          ],
        }) +
        "\n```",
      output: [],
    });

    const { token } = makeSession();
    const res = await request(app)
      .post("/public-ai/chat")
      .set("Cookie", `ora-session=${token}`)
      .send({
        message: "find me a youtube video about composting",
        messages: [],
        referenceSavedMemories: false,
      });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.videos)).toBe(true);
    // Only the verifiable video survives; the hallucinated one is dropped.
    expect(res.body.videos.length).toBe(1);
    expect(res.body.videos[0].url).toContain("dQw4w9WgXcQ");
    expect(res.body.videos.some((v: { url: string }) => v.url.includes("doesnotexist"))).toBe(false);
  });
});
