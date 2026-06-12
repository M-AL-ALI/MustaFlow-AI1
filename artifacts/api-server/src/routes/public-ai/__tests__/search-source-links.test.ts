/**
 * Integration test — cited source links end-to-end through the Ora chat route.
 *
 * Covers the full request path the unit tests miss:
 *   POST /public-ai/chat  →  orchestrator routes a web-search message to the
 *   `search` tool  →  runOraWebSearch calls the OpenAI Responses API  →
 *   extractSources + cleanSourceUrl + dedupeSources turn the Responses-API URL
 *   annotations into a clean list  →  the route returns a populated, URL-safe,
 *   deduped `sources` array that the UI renders as the citation links beneath a
 *   web-search answer.
 *
 * Mirrors the media coverage (search-image-cards.test.ts / search-video-cards
 * .test.ts). The key difference is provenance: `sources` come from the Responses
 * API `output` annotations (extractSources), NOT from the trailing ora-media
 * block — so the mocked payload here carries `output[*].content[*].annotations`,
 * and `output_text` carries no ora-media block.
 *
 * The OpenAI Responses API is mocked at the SDK boundary (not at
 * runOraWebSearch), so the real prompt → extract → clean → dedupe → response
 * pipeline runs. This test is deterministic and always runs in CI.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";
import { isSafeHttpUrl } from "../../../lib/public-ai/web-search";

const TEST_SECRET = "search-source-links-test-secret";

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock the OpenAI SDK so responses.create returns a deterministic reply that
// carries URL citations in the Responses-API `output` annotations. The route's
// real extractSources → cleanSourceUrl → dedupeSources must strip tracking
// params, drop unsafe/non-http URLs, and dedupe the duplicate citation.
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
    sessionId: "source-link-session-" + Math.random().toString(36).slice(2),
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

/** Build a Responses-API `output` payload carrying URL citation annotations. */
function outputWithAnnotations(annotations: Array<{ url: string; title?: string }>): unknown[] {
  return [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "answer body",
          annotations: annotations.map((a) => ({
            type: "url_citation",
            url: a.url,
            ...(a.title ? { title: a.title } : {}),
          })),
        },
      ],
    },
  ];
}

describe("POST /public-ai/chat — cited source links via live web search (mocked provider)", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    createMock.mockReset();
    app = await buildApp();
  });

  it("returns a populated, URL-safe, deduped sources array with tracking params stripped", async () => {
    createMock.mockResolvedValueOnce({
      output_text: "Here is what I found about the Eiffel Tower.",
      output: outputWithAnnotations([
        // Tracking params (the web_search tool appends ?utm_source=openai) must
        // be stripped, leaving a clean canonical URL.
        {
          url: "https://en.wikipedia.org/wiki/Eiffel_Tower?utm_source=openai&utm_medium=ai",
          title: "Eiffel Tower - Wikipedia",
        },
        // Duplicate of the first citation (different tracking params + trailing
        // slash) — must be deduped away by normalized host+path.
        {
          url: "https://en.wikipedia.org/wiki/Eiffel_Tower/?fbclid=abc123",
          title: "Eiffel Tower (dup)",
        },
        // A distinct, clean source with a fbclid/gclid to strip.
        {
          url: "https://www.toureiffel.paris/en?gclid=xyz&ref=home",
          title: "Official site",
        },
        // Unsafe loopback URL — must be dropped by cleanSourceUrl/isSafeHttpUrl.
        { url: "http://127.0.0.1/internal", title: "evil" },
        // Non-http(s) scheme — must be dropped.
        { url: "javascript:alert(1)", title: "xss" },
      ]),
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
    expect(Array.isArray(res.body.sources)).toBe(true);
    // Two distinct safe sources survive (the duplicate is deduped; the loopback
    // and javascript: URLs are dropped).
    expect(res.body.sources.length).toBe(2);

    // Every surviving source is a safe, clickable http(s) link.
    expect(res.body.sources.every((s: { url: string }) => isSafeHttpUrl(s.url))).toBe(true);

    // Tracking params are stripped from every cited URL.
    for (const s of res.body.sources as Array<{ url: string }>) {
      expect(s.url).not.toMatch(/utm_/i);
      expect(s.url).not.toContain("fbclid");
      expect(s.url).not.toContain("gclid");
      expect(s.url).not.toMatch(/[?&]ref=/);
    }

    // Unsafe targets never reach the response.
    expect(res.body.sources.some((s: { url: string }) => s.url.includes("127.0.0.1"))).toBe(false);
    expect(res.body.sources.some((s: { url: string }) => s.url.startsWith("javascript:"))).toBe(
      false,
    );

    // The Wikipedia citation is present exactly once (deduped) and carries a title.
    const wiki = (res.body.sources as Array<{ url: string; title: string }>).filter((s) =>
      s.url.includes("en.wikipedia.org/wiki/Eiffel_Tower"),
    );
    expect(wiki.length).toBe(1);
    expect(typeof wiki[0].title).toBe("string");
    expect(wiki[0].title.length).toBeGreaterThan(0);

    // The distinct official source survives.
    expect(res.body.sources.some((s: { url: string }) => s.url.includes("toureiffel.paris"))).toBe(
      true,
    );

    // The visible reply is returned untouched.
    expect(typeof res.body.reply).toBe("string");
    expect(res.body.reply.length).toBeGreaterThan(0);
  });

  it("returns an empty sources array when the provider cites only unsafe URLs", async () => {
    createMock.mockResolvedValueOnce({
      output_text: "Here is what I found.",
      output: outputWithAnnotations([
        { url: "http://10.0.0.5/private", title: "private" },
        { url: "file:///etc/passwd", title: "local" },
        { url: "javascript:alert(1)", title: "xss" },
      ]),
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
    expect(Array.isArray(res.body.sources)).toBe(true);
    expect(res.body.sources.length).toBe(0);
  });
});
