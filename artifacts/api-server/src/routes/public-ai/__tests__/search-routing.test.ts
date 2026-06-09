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

// A precomputed classifier result lets routeOraMessage skip the live LLM
// classifier call on the conversational fallthrough — keeping these routing
// tests fast and deterministic (no network).
const STUB_CLASSIFIER = {
  intent: "premium",
  confidence: "high",
  topic: "general",
} as const;

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

// ─── isImageGenerationRequest ─────────────────────────────────────────────────

describe("isImageGenerationRequest", () => {
  it("matches natural image-generation phrasings", () => {
    // Verb + visual noun (already covered, kept as sanity)
    expect(isImageGenerationRequest("generate an image of a sunset")).toBe(true);
    expect(isImageGenerationRequest("create a logo for my bakery")).toBe(true);
    expect(isImageGenerationRequest("make me a picture of a cat")).toBe(true);
    // Drawing/painting verbs without an explicit visual noun
    expect(isImageGenerationRequest("draw a dog")).toBe(true);
    expect(isImageGenerationRequest("sketch a robot")).toBe(true);
    expect(isImageGenerationRequest("paint a dragon")).toBe(true);
    // Request/desire framing + visual noun
    expect(isImageGenerationRequest("give me a banner")).toBe(true);
    expect(isImageGenerationRequest("I need a logo")).toBe(true);
    expect(isImageGenerationRequest("I'd like an illustration of a forest")).toBe(true);
    // Bare brandable noun + preposition, no leading verb
    expect(isImageGenerationRequest("a logo for my mechanic app")).toBe(true);
    expect(isImageGenerationRequest("an icon for the button")).toBe(true);
    // Drawing verb behind a genuine request lead-in still matches
    expect(isImageGenerationRequest("I want to draw a dog")).toBe(true);
    expect(isImageGenerationRequest("can you draw a cat")).toBe(true);
  });

  it("does NOT hijack figurative or non-image requests", () => {
    expect(isImageGenerationRequest("draw a conclusion from this data")).toBe(false);
    expect(isImageGenerationRequest("draw the line at three retries")).toBe(false);
    expect(isImageGenerationRequest("illustrate my point with an example")).toBe(false);
    expect(isImageGenerationRequest("illustrate a concept with an example")).toBe(false);
    expect(isImageGenerationRequest("draw my attention to the key risks")).toBe(false);
    expect(isImageGenerationRequest("I need a website for my bakery")).toBe(false);
    expect(isImageGenerationRequest("give me a summary of this file")).toBe(false);
    expect(isImageGenerationRequest("make a plan for the launch")).toBe(false);
    expect(isImageGenerationRequest("what is the best logo design software")).toBe(false);
    // Mid-sentence mention of a logo is a statement, not a request.
    expect(isImageGenerationRequest("I used a logo for my app")).toBe(false);
    // Instructional / how-to framing wants a tutorial, not an image.
    expect(isImageGenerationRequest("how to paint a room")).toBe(false);
    expect(isImageGenerationRequest("how do i draw a dog")).toBe(false);
    // Video creation must not be treated as image generation.
    expect(isImageGenerationRequest("generate a video of a sunset")).toBe(false);
  });

  it("routes a verb-less image request to image_generation, not the conversational path", async () => {
    const decision = await routeOraMessage({
      message: "a logo for my mechanic app",
      mode: "instant",
    });
    expect(decision.tool).toBe("image_generation");
  });
});

describe("image generation continuation", () => {
  it("routes 'go ahead and do it' after an image offer to image_generation with a resolved prompt", async () => {
    const decision = await routeOraMessage({
      message: "go ahead and do it",
      mode: "instant",
      recentMessages: [
        { role: "user", content: "I run a mechanic shop" },
        {
          role: "assistant",
          content: "I can generate a logo for your mechanic shop — want me to?",
        },
      ],
    });
    expect(decision.tool).toBe("image_generation");
    expect(decision.imagePrompt).toBe("a logo for your mechanic shop");
  });

  it("routes generation-verb continuations ('go ahead and create it', 'yes create it') to image_generation", async () => {
    const offer = [
      {
        role: "assistant" as const,
        content: "I can generate a logo for your shop — want me to?",
      },
    ];
    for (const message of [
      "go ahead and create it",
      "go ahead and make it",
      "yes create it",
      "create it",
      "go ahead and generate the image",
    ]) {
      const decision = await routeOraMessage({ message, mode: "instant", recentMessages: offer });
      expect(decision.tool, `"${message}" should be an image continuation`).toBe(
        "image_generation",
      );
    }
  });

  it("does not reuse a STALE earlier image request when the nearest user turn is unrelated", async () => {
    const decision = await routeOraMessage({
      message: "yes go ahead",
      mode: "instant",
      recentMessages: [
        { role: "user", content: "make me a logo for my bakery" },
        { role: "assistant", content: "Here's a bakery logo concept..." },
        { role: "user", content: "what hours should a bakery keep?" },
        {
          role: "assistant",
          content: "I can generate an illustration of a coffee cup — want me to?",
        },
      ],
    });
    expect(decision.tool).toBe("image_generation");
    // Must resolve to the offer's subject (coffee cup), NOT the stale bakery logo.
    expect(decision.imagePrompt ?? "").not.toContain("bakery");
    expect((decision.imagePrompt ?? "").toLowerCase()).toContain("coffee");
  });

  it("does NOT treat a question after an image offer as a continuation", async () => {
    // Questions share tokens with continuations ("make it", "do it") but ask
    // rather than affirm — the continuation gate must reject them so they don't
    // silently auto-generate the offered image.
    const offer = [
      {
        role: "assistant" as const,
        content: "I can generate a logo for your shop — want me to?",
      },
    ];
    for (const message of ["can you make it", "make it?", "do it?"]) {
      const decision = await routeOraMessage({
        message,
        mode: "instant",
        recentMessages: offer,
        classifier: STUB_CLASSIFIER,
      });
      expect(decision.tool, `"${message}" should not auto-generate`).not.toBe("image_generation");
    }
  });

  it("prefers the user's own prior image request as the resolved prompt", async () => {
    const decision = await routeOraMessage({
      message: "yes please",
      mode: "instant",
      recentMessages: [
        { role: "user", content: "make me a picture of a red sports car at sunset" },
        {
          role: "assistant",
          content: "Sure — I can generate that image for you. Want me to go ahead?",
        },
      ],
    });
    expect(decision.tool).toBe("image_generation");
    expect(decision.imagePrompt).toBe("make me a picture of a red sports car at sunset");
  });

  it("does NOT treat an affirmation after a FILE offer as an image continuation", async () => {
    const decision = await routeOraMessage({
      message: "go ahead",
      mode: "instant",
      recentMessages: [
        { role: "assistant", content: "I can put together a PDF report for you. Want me to?" },
      ],
    });
    expect(decision.tool).toBe("file_generation");
    expect(decision.imagePrompt).toBeUndefined();
  });

  it("does NOT generate when there was no offer to continue", async () => {
    const decision = await routeOraMessage({
      message: "go ahead",
      mode: "instant",
      recentMessages: [
        { role: "assistant", content: "Here is some general advice about running a shop." },
      ],
      classifier: STUB_CLASSIFIER,
    });
    expect(decision.tool).toBe("answer");
  });

  it("does NOT treat a follow-up question after an image offer as a continuation", async () => {
    const decision = await routeOraMessage({
      message: "what would it cost?",
      mode: "instant",
      recentMessages: [
        { role: "assistant", content: "I can generate a banner for your site. Want me to?" },
      ],
      classifier: STUB_CLASSIFIER,
    });
    expect(decision.tool).toBe("answer");
  });

  it("does NOT treat a modifier-bearing reply as a pure continuation (would discard the qualifier)", async () => {
    const offer = [
      {
        role: "assistant" as const,
        content: "I can generate a logo for your shop — want me to?",
      },
    ];
    // Each of these carries a NEW qualifier; routing to the stale context prompt
    // would silently drop it, so they must fall through to the conversational path.
    for (const message of [
      "make it blue",
      "go ahead with neon colors",
      "make it 16:9",
      "make it pop with red",
    ]) {
      const decision = await routeOraMessage({
        message,
        mode: "instant",
        recentMessages: offer,
        classifier: STUB_CLASSIFIER,
      });
      expect(decision.tool, `"${message}" should not be an image continuation`).toBe("answer");
      expect(decision.imagePrompt).toBeUndefined();
    }
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
