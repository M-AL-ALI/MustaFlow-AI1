/**
 * Web-search media extraction tests for the Ora public-AI assistant.
 *
 * Covers web-search.ts media helpers:
 *   - youtubeId / youtubeThumbnail: stable thumbnail derivation across URL forms
 *   - sanitizeImages / sanitizeVideos: http(s)-only, dedupe, cap, source/thumb handling
 *   - parseOraMediaBlock: strips the trailing fenced block, never throws on bad JSON
 *
 * These are pure-function tests (no DB, no network).
 */

import { describe, it, expect } from "vitest";
import {
  youtubeId,
  youtubeThumbnail,
  sanitizeImages,
  sanitizeVideos,
  parseOraMediaBlock,
  isSafeHttpUrl,
  isPrivateOrLocalHost,
  buildInstructions,
} from "../../../lib/public-ai/web-search";

describe("isPrivateOrLocalHost", () => {
  it("flags loopback, private, link-local and metadata hosts", () => {
    for (const h of [
      "localhost",
      "app.localhost",
      "printer.local",
      "svc.internal",
      "127.0.0.1",
      "0.0.0.0",
      "10.0.0.5",
      "172.16.4.4",
      "172.31.255.1",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
      "fe80::1",
    ]) {
      expect(isPrivateOrLocalHost(h), h).toBe(true);
    }
  });

  it("allows public hosts", () => {
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "192.169.0.1", "203.0.113.7"]) {
      expect(isPrivateOrLocalHost(h), h).toBe(false);
    }
  });

  it("blocks trailing-dot and IPv4-mapped-IPv6 bypass forms", () => {
    expect(isPrivateOrLocalHost("localhost.")).toBe(true);
    expect(isPrivateOrLocalHost("127.0.0.1.")).toBe(true);
    expect(isPrivateOrLocalHost("printer.local.")).toBe(true);
    expect(isPrivateOrLocalHost("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrLocalHost("::ffff:192.168.1.1")).toBe(true);
  });
});

describe("isSafeHttpUrl rejects internal targets", () => {
  it("blocks private/local http(s) URLs", () => {
    expect(isSafeHttpUrl("http://127.0.0.1/x.jpg")).toBe(false);
    expect(isSafeHttpUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isSafeHttpUrl("https://intranet.local/a.png")).toBe(false);
  });
  it("allows public http(s) URLs", () => {
    expect(isSafeHttpUrl("https://example.com/a.jpg")).toBe(true);
  });
});

describe("youtubeId", () => {
  it("extracts id from watch URLs", () => {
    expect(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
  it("extracts id from youtu.be short links", () => {
    expect(youtubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
  it("extracts id from shorts and embed paths", () => {
    expect(youtubeId("https://youtube.com/shorts/abc123XYZ_-")).toBe("abc123XYZ_-");
    expect(youtubeId("https://www.youtube.com/embed/abc123XYZ_-")).toBe("abc123XYZ_-");
  });
  it("returns null for non-YouTube or malformed URLs", () => {
    expect(youtubeId("https://vimeo.com/12345")).toBeNull();
    expect(youtubeId("not a url")).toBeNull();
  });
});

describe("youtubeThumbnail", () => {
  it("derives a stable thumbnail for YouTube links", () => {
    expect(youtubeThumbnail("https://youtu.be/dQw4w9WgXcQ")).toBe(
      "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    );
  });
  it("returns null for non-YouTube links", () => {
    expect(youtubeThumbnail("https://vimeo.com/12345")).toBeNull();
  });
});

describe("sanitizeImages", () => {
  it("keeps only http(s) image URLs and caps the count", () => {
    const out = sanitizeImages([
      { url: "https://a.com/1.jpg", title: "One" },
      { url: "http://b.com/2.png" },
      { url: "javascript:alert(1)" },
      { url: "data:image/png;base64,xxxx" },
      { url: "https://c.com/3.jpg" },
      { url: "https://d.com/4.jpg" },
      { url: "https://e.com/5.jpg" },
    ]);
    expect(out.length).toBe(4);
    expect(out.every((i) => /^https?:\/\//.test(i.url))).toBe(true);
  });

  it("dedupes repeated URLs", () => {
    const out = sanitizeImages([
      { url: "https://a.com/1.jpg" },
      { url: "https://a.com/1.jpg" },
    ]);
    expect(out.length).toBe(1);
  });

  it("keeps source only when it is a safe http(s) URL", () => {
    const out = sanitizeImages([
      { url: "https://a.com/1.jpg", source: "https://a.com/article" },
      { url: "https://b.com/2.jpg", source: "javascript:bad" },
    ]);
    expect(out[0].source).toBe("https://a.com/article");
    expect(out[1].source).toBeUndefined();
  });

  it("returns [] for non-array input", () => {
    expect(sanitizeImages(null)).toEqual([]);
    expect(sanitizeImages("nope")).toEqual([]);
  });
});

describe("sanitizeVideos", () => {
  it("derives YouTube thumbnails and caps the count", () => {
    const out = sanitizeVideos([
      { url: "https://youtu.be/dQw4w9WgXcQ", title: "Vid" },
      { url: "https://vimeo.com/12345" },
      { url: "https://example.com/watch" },
      { url: "https://example.com/another" },
    ]);
    expect(out.length).toBe(3);
    expect(out[0].thumbnailUrl).toBe("https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  });

  it("uses a model-supplied thumbnail for non-YouTube videos when safe", () => {
    const out = sanitizeVideos([
      { url: "https://vimeo.com/12345", thumbnailUrl: "https://cdn.vimeo.com/t.jpg" },
    ]);
    expect(out[0].thumbnailUrl).toBe("https://cdn.vimeo.com/t.jpg");
  });

  it("drops non-http(s) video URLs", () => {
    const out = sanitizeVideos([{ url: "ftp://x.com/v.mp4" }, { url: "https://ok.com/v" }]);
    expect(out.length).toBe(1);
    expect(out[0].url).toBe("https://ok.com/v");
  });
});

describe("parseOraMediaBlock", () => {
  it("extracts media and strips the ora-media block from the text", () => {
    const reply =
      "Here is your answer.\n\n```ora-media\n" +
      JSON.stringify({
        images: [{ url: "https://a.com/1.jpg", title: "Pic" }],
        videos: [{ url: "https://youtu.be/dQw4w9WgXcQ" }],
      }) +
      "\n```";
    const out = parseOraMediaBlock(reply);
    expect(out.text).toBe("Here is your answer.");
    expect(out.images.length).toBe(1);
    expect(out.videos.length).toBe(1);
    expect(out.videos[0].thumbnailUrl).toContain("img.youtube.com");
  });

  it("falls back to a generic json fence carrying images/videos", () => {
    const reply =
      "Answer.\n```json\n" +
      JSON.stringify({ images: [{ url: "https://a.com/1.jpg" }], videos: [] }) +
      "\n```";
    const out = parseOraMediaBlock(reply);
    expect(out.text).toBe("Answer.");
    expect(out.images.length).toBe(1);
  });

  it("does not treat an unrelated json fence as media", () => {
    const reply = "Answer.\n```json\n{\"foo\":1}\n```";
    const out = parseOraMediaBlock(reply);
    expect(out.text).toContain("```json");
    expect(out.images).toEqual([]);
    expect(out.videos).toEqual([]);
  });

  it("never throws on malformed JSON and still strips the block", () => {
    const reply = "Answer.\n```ora-media\n{ not valid json ,, }\n```";
    const out = parseOraMediaBlock(reply);
    expect(out.text).toBe("Answer.");
    expect(out.images).toEqual([]);
    expect(out.videos).toEqual([]);
  });

  it("returns the plain reply when there is no media block", () => {
    const out = parseOraMediaBlock("Just a plain answer.");
    expect(out.text).toBe("Just a plain answer.");
    expect(out.images).toEqual([]);
    expect(out.videos).toEqual([]);
  });
});

describe("buildInstructions personalization", () => {
  it("omits any personalization block when no context is supplied", () => {
    const out = buildInstructions("auto");
    expect(out).not.toContain("what you already know about this user");
  });

  it("omits the block for empty / whitespace-only context", () => {
    expect(buildInstructions("auto", "")).not.toContain("what you already know about this user");
    expect(buildInstructions("auto", "   \n  ")).not.toContain(
      "what you already know about this user",
    );
  });

  it("appends the user's profile/memory context when provided", () => {
    const ctx = "\n\n## About the user\n- Preferred name: Sam\n- Industry: Coffee";
    const out = buildInstructions("auto", ctx);
    expect(out).toContain("what you already know about this user");
    expect(out).toContain("Preferred name: Sam");
    expect(out).toContain("Industry: Coffee");
  });

  it("instructs the model to use context silently and not to disclose it", () => {
    const out = buildInstructions("auto", "\n\n## About the user\n- City: Austin");
    expect(out).toContain("silently");
    expect(out).toContain("never present them as if they came from the web search");
  });

  it("still requires the trailing ora-media block alongside personalization", () => {
    const out = buildInstructions("auto", "\n\n## About the user\n- City: Austin");
    expect(out).toContain("ora-media");
    // Personalization is appended AFTER the media-block instruction.
    expect(out.indexOf("ora-media")).toBeLessThan(out.indexOf("what you already know"));
  });
});
