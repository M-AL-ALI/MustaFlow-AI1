/**
 * Web-search routing + source-safety tests for the Ora public-AI assistant.
 *
 * Covers:
 *   - orchestrator.ts: isWebSearchRequest patterns, routeOraMessage picks the
 *     `search` tool for current-info questions, and checkToolAccess denies an
 *     anonymous visitor with the `search_signin_required` code.
 *   - web-search.ts: isSafeHttpUrl, cleanSourceUrl, extractSources, dedupeSources
 *     — the citation safety + de-duplication helpers.
 *
 * These are pure-function tests (no DB, no network).
 */

import { describe, it, expect } from "vitest";
import {
  isWebSearchRequest,
  isVideoRequest,
  routeOraMessage,
  checkToolAccess,
  isImageGenerationRequest,
} from "../../../lib/public-ai/orchestrator";
import {
  isSafeHttpUrl,
  cleanSourceUrl,
  extractSources,
  dedupeSources,
  type OraSource,
} from "../../../lib/public-ai/web-search";

// ─── isWebSearchRequest ───────────────────────────────────────────────────────

describe("isWebSearchRequest", () => {
  it("matches explicit search-the-web phrasing", () => {
    expect(isWebSearchRequest("search the web for the best laptops")).toBe(true);
    expect(isWebSearchRequest("can you look up online what time it is in Tokyo")).toBe(true);
    expect(isWebSearchRequest("google the latest react release")).toBe(true);
  });

  it("matches current/live-information questions", () => {
    expect(isWebSearchRequest("what's the latest news on the election")).toBe(true);
    expect(isWebSearchRequest("what is the current bitcoin price")).toBe(true);
    expect(isWebSearchRequest("who won the game today")).toBe(true);
    expect(isWebSearchRequest("what's the weather in Paris tomorrow")).toBe(true);
  });

  it("matches website / homepage / URL lookups for a brand or company", () => {
    expect(isWebSearchRequest("find perdue's website and logo")).toBe(true);
    expect(isWebSearchRequest("find perdue website")).toBe(true);
    expect(isWebSearchRequest("search on the market and find the perdue website")).toBe(true);
    expect(isWebSearchRequest("look up the official site for Tesla")).toBe(true);
    expect(isWebSearchRequest("what's the homepage of OpenAI")).toBe(true);
    expect(isWebSearchRequest("get me the url for the New York Times")).toBe(true);
  });

  it("does NOT hijack ordinary product / how-to questions", () => {
    expect(isWebSearchRequest("how do I build a todo app with MustaFlow?")).toBe(false);
    expect(isWebSearchRequest("explain how closures work in JavaScript")).toBe(false);
    expect(isWebSearchRequest("write me a poem about the ocean")).toBe(false);
    expect(isWebSearchRequest("what can I build here")).toBe(false);
    // Website-related but NOT a lookup — must stay conversational.
    expect(isWebSearchRequest("what is a good website builder")).toBe(false);
    expect(isWebSearchRequest("how do I add a search bar to my app")).toBe(false);
    expect(isWebSearchRequest("build me a website for my bakery")).toBe(false);
    // Internal "look up / search" over the user's own data — NOT a web search.
    expect(isWebSearchRequest("look up this value in my uploaded file")).toBe(false);
    expect(isWebSearchRequest("search for duplicates in this CSV")).toBe(false);
    expect(isWebSearchRequest("look up this function in the docs I pasted")).toBe(false);
  });
});

// ─── isVideoRequest ───────────────────────────────────────────────────────────

describe("isVideoRequest", () => {
  it("matches explicit requests to FIND a video", () => {
    expect(isVideoRequest("show me a video about composting")).toBe(true);
    expect(isVideoRequest("find a youtube video on sourdough starters")).toBe(true);
    expect(isVideoRequest("got any related videos?")).toBe(true);
    expect(isVideoRequest("can you find me some videos on knot tying")).toBe(true);
    expect(isVideoRequest("recommend a clip explaining recursion")).toBe(true);
    expect(isVideoRequest("are there any videos that walk through this")).toBe(true);
    expect(isVideoRequest("do you have any videos on this topic")).toBe(true);
    expect(isVideoRequest("got any clips on this")).toBe(true);
    expect(isVideoRequest("show me more videos like that")).toBe(true);
  });

  it("does NOT hijack build / app / conversational requests that mention video", () => {
    // Creation/build verbs must never be treated as a video-find request.
    expect(isVideoRequest("build me a video streaming app")).toBe(false);
    expect(isVideoRequest("create a video player component")).toBe(false);
    expect(isVideoRequest("generate a video of a sunset")).toBe(false);
    expect(isVideoRequest("how do video codecs work?")).toBe(false);
    expect(isVideoRequest("what is the best video editing software")).toBe(false);
    expect(isVideoRequest("explain how youtube's algorithm works")).toBe(false);
  });

  it("does NOT match statements that merely mention having a video (no request)", () => {
    // These are the over-broad false positives the patterns must avoid: a user
    // describing their own app/data, not asking Ora to find a video.
    expect(isVideoRequest("I have a video editing bug")).toBe(false);
    expect(isVideoRequest("I have a video player issue")).toBe(false);
    expect(isVideoRequest("we have some videos in our app")).toBe(false);
    expect(isVideoRequest("get the video player working")).toBe(false);
    expect(isVideoRequest("do you support any video formats")).toBe(false);
  });
});

// ─── routeOraMessage → search ─────────────────────────────────────────────────

describe("routeOraMessage routes video requests to the search/media path", () => {
  it("routes a video-find request to `search` with wantsVideos set", async () => {
    const decision = await routeOraMessage({
      message: "show me a video about composting",
      mode: "instant",
    });
    expect(decision.tool).toBe("search");
    expect(decision.wantsVideos).toBe(true);
  });

  it("routes video requests to search in deep mode too", async () => {
    const decision = await routeOraMessage({
      message: "find me a youtube video on sourdough",
      mode: "deep",
    });
    expect(decision.tool).toBe("search");
    expect(decision.wantsVideos).toBe(true);
  });

  it("does NOT set wantsVideos for an ordinary live-info search", async () => {
    const decision = await routeOraMessage({
      message: "what is the current bitcoin price",
      mode: "instant",
    });
    expect(decision.tool).toBe("search");
    expect(decision.wantsVideos).toBeUndefined();
  });

  it("does NOT route a 'build a video app' request to search", async () => {
    const decision = await routeOraMessage({
      message: "build me a video streaming app",
      mode: "instant",
      // Provide a classifier so the conversational fallback doesn't make a live
      // AI call (this message intentionally falls through all fast-paths).
      classifier: { intent: "builder_request", confidence: "high", topic: "general" },
    });
    expect(decision.tool).not.toBe("search");
  });
});

describe("routeOraMessage picks the search tool for live-info questions", () => {
  it("routes a current-info question to `search` regardless of mode", async () => {
    const instant = await routeOraMessage({
      message: "what is the current bitcoin price",
      mode: "instant",
    });
    expect(instant.tool).toBe("search");

    const deep = await routeOraMessage({
      message: "what is the current bitcoin price",
      mode: "deep",
    });
    // Search beats the instant/deep classifier — a grounded answer always wins.
    expect(deep.tool).toBe("search");
  });

  it("prefers an image-generation request over search when both could match", async () => {
    // Sanity: image fast-path runs before search, so a clear image request wins.
    expect(isImageGenerationRequest("generate an image of a sunset")).toBe(true);
    const decision = await routeOraMessage({
      message: "generate an image of a sunset",
      mode: "instant",
    });
    expect(decision.tool).toBe("image_generation");
  });
});

// ─── checkToolAccess for search ───────────────────────────────────────────────

describe("checkToolAccess('search')", () => {
  it("denies an anonymous visitor with search_signin_required", () => {
    const result = checkToolAccess("search", { authed: false, isPaid: false });
    expect(result.allowed).toBe(false);
    expect(result.denyCode).toBe("search_signin_required");
  });

  it("allows a signed-in free user", () => {
    const result = checkToolAccess("search", { authed: true, isPaid: false });
    expect(result.allowed).toBe(true);
    expect(result.denyCode).toBeUndefined();
  });
});

// ─── web-search.ts safety helpers ─────────────────────────────────────────────

describe("isSafeHttpUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isSafeHttpUrl("https://example.com/article")).toBe(true);
    expect(isSafeHttpUrl("http://example.com")).toBe(true);
  });

  it("rejects javascript:, data:, file:, and malformed URLs", () => {
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isSafeHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeHttpUrl("not a url")).toBe(false);
    expect(isSafeHttpUrl("")).toBe(false);
  });
});

describe("cleanSourceUrl", () => {
  it("returns a normalized http(s) URL", () => {
    expect(cleanSourceUrl("https://example.com/a")).toBe("https://example.com/a");
  });

  it("returns null for unsafe schemes", () => {
    expect(cleanSourceUrl("javascript:alert(1)")).toBeNull();
    expect(cleanSourceUrl("data:text/plain,hi")).toBeNull();
  });
});

describe("dedupeSources", () => {
  it("removes duplicate URLs and caps the count", () => {
    const sources: OraSource[] = [
      { title: "A", url: "https://example.com/1" },
      { title: "A again", url: "https://example.com/1" },
      { title: "B", url: "https://example.com/2" },
      { title: "C", url: "https://example.com/3" },
    ];
    const deduped = dedupeSources(sources, 2);
    expect(deduped.length).toBe(2);
    expect(deduped[0].url).toBe("https://example.com/1");
    expect(deduped[1].url).toBe("https://example.com/2");
  });
});

describe("extractSources never returns unsafe links", () => {
  it("drops citations with non-http(s) schemes", () => {
    // Shape mirrors the OpenAI Responses API url_citation annotations.
    const output = [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "answer",
            annotations: [
              {
                type: "url_citation",
                url: "https://good.example.com/article",
                title: "Good source",
              },
              {
                type: "url_citation",
                url: "javascript:alert(1)",
                title: "Evil source",
              },
            ],
          },
        ],
      },
    ];
    const sources = extractSources(output);
    expect(sources.every((s) => isSafeHttpUrl(s.url))).toBe(true);
    expect(sources.some((s) => s.url.startsWith("javascript:"))).toBe(false);
  });
});
