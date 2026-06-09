/**
 * Unit tests for extractProseVideos + mergeVideos.
 *
 * The model is instructed to put videos in the trailing ora-media block, but it
 * routinely inlines a YouTube/Vimeo URL straight in the prose instead. Those
 * inline URLs would otherwise render as plain, unverified, often-dead links
 * (never as a play card). extractProseVideos lifts every embeddable video URL
 * out of the text — so it joins the verify + card pipeline — and strips it from
 * the prose so no raw video link is ever shown.
 */

import { describe, it, expect } from "vitest";
import { extractProseVideos, mergeVideos } from "../web-search";

describe("extractProseVideos", () => {
  it("lifts a bare YouTube watch URL out of the prose and strips it", () => {
    const { text, videos } = extractProseVideos(
      "Sure! Check out this clip: https://www.youtube.com/watch?v=dQw4w9WgXcQ it's great.",
    );
    expect(videos).toHaveLength(1);
    expect(videos[0].url).toContain("watch?v=dQw4w9WgXcQ");
    // The raw URL must not survive in the visible text.
    expect(text).not.toContain("youtube.com");
    expect(text).not.toContain("http");
  });

  it("lifts a markdown-linked video but keeps the human label text", () => {
    const { text, videos } = extractProseVideos(
      "Watch [this tutorial](https://youtu.be/9bZkp7q19f0) to learn more.",
    );
    expect(videos).toHaveLength(1);
    expect(videos[0].title).toBe("this tutorial");
    expect(text).toContain("this tutorial");
    expect(text).not.toContain("youtu.be");
    expect(text).not.toContain("](");
  });

  it("derives a thumbnail for YouTube links", () => {
    const { videos } = extractProseVideos("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(videos[0].thumbnailUrl).toContain("img.youtube.com");
  });

  it("lifts Vimeo URLs too", () => {
    const { text, videos } = extractProseVideos("Here: https://vimeo.com/123456789 enjoy.");
    expect(videos).toHaveLength(1);
    expect(videos[0].url).toContain("vimeo.com/123456789");
    expect(text).not.toContain("vimeo.com");
  });

  it("leaves non-video links untouched in the prose", () => {
    const input = "See the docs at https://example.com/guide for details.";
    const { text, videos } = extractProseVideos(input);
    expect(videos).toHaveLength(0);
    expect(text).toContain("https://example.com/guide");
  });

  it("de-duplicates the same video mentioned twice", () => {
    const { videos } = extractProseVideos(
      "First https://www.youtube.com/watch?v=dQw4w9WgXcQ and again https://youtu.be/dQw4w9WgXcQ",
    );
    expect(videos).toHaveLength(1);
  });

  it("handles multiple distinct videos in one reply", () => {
    const { videos } = extractProseVideos(
      "One: https://www.youtube.com/watch?v=dQw4w9WgXcQ Two: https://youtu.be/9bZkp7q19f0",
    );
    expect(videos).toHaveLength(2);
  });

  it("returns the text unchanged when there are no URLs", () => {
    const input = "Just a normal sentence with no links at all.";
    const { text, videos } = extractProseVideos(input);
    expect(videos).toHaveLength(0);
    expect(text).toBe(input);
  });

  it("is empty-safe", () => {
    expect(extractProseVideos("")).toEqual({ text: "", videos: [] });
  });

  it("tidies whitespace and dangling punctuation left where a URL was removed", () => {
    const { text } = extractProseVideos(
      "Watch this one: https://www.youtube.com/watch?v=dQw4w9WgXcQ .",
    );
    expect(text).not.toMatch(/\s{2,}/);
    expect(text).not.toMatch(/\s\.$/);
  });
});

describe("mergeVideos", () => {
  it("merges lists and de-duplicates by URL, preserving order", () => {
    const a = [{ url: "https://youtu.be/aaaaaa", title: "A" }];
    const b = [
      { url: "https://youtu.be/aaaaaa", title: "dupe" },
      { url: "https://youtu.be/bbbbbb", title: "B" },
    ];
    const merged = mergeVideos(a, b);
    expect(merged).toHaveLength(2);
    expect(merged[0].title).toBe("A");
    expect(merged[1].url).toContain("bbbbbb");
  });

  it("returns an empty array for no input", () => {
    expect(mergeVideos()).toEqual([]);
  });

  it("de-dupes the same YouTube video across URL forms (youtu.be vs watch?v=)", () => {
    const fromMediaBlock = [{ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "block" }];
    const fromProse = [{ url: "https://youtu.be/dQw4w9WgXcQ", title: "prose" }];
    const merged = mergeVideos(fromMediaBlock, fromProse);
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe("block");
  });
});
