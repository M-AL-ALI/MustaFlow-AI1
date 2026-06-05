import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { OraSourceCards, isSafeHttpUrl } from "../ora-source-cards";
import type { OraSource } from "@/hooks/use-ora-chat";

afterEach(() => cleanup());

describe("isSafeHttpUrl", () => {
  it("accepts http and https", () => {
    expect(isSafeHttpUrl("https://example.com")).toBe(true);
    expect(isSafeHttpUrl("http://example.com")).toBe(true);
  });

  it("rejects javascript:, data:, and malformed URLs", () => {
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("data:text/html,<script>")).toBe(false);
    expect(isSafeHttpUrl("nope")).toBe(false);
  });
});

describe("OraSourceCards", () => {
  it("renders a clickable anchor for each safe http(s) source", () => {
    const sources: OraSource[] = [
      { title: "Example One", url: "https://example.com/a" },
      { title: "Example Two", url: "http://example.org/b" },
    ];
    const { container } = render(<OraSourceCards sources={sources} />);
    const anchors = container.querySelectorAll("a[href]");
    expect(anchors.length).toBe(2);
    const hrefs = Array.from(anchors).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://example.com/a");
    expect(hrefs).toContain("http://example.org/b");
    // External links must open safely.
    anchors.forEach((a) => {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
    });
  });

  it("drops javascript: and data: URLs so they never become live links", () => {
    const sources: OraSource[] = [
      { title: "Safe", url: "https://safe.example.com" },
      { title: "Evil JS", url: "javascript:alert(1)" },
      { title: "Evil Data", url: "data:text/html,<script>alert(1)</script>" },
    ];
    const { container } = render(<OraSourceCards sources={sources} />);
    const anchors = container.querySelectorAll("a[href]");
    expect(anchors.length).toBe(1);
    expect(anchors[0].getAttribute("href")).toBe("https://safe.example.com");
  });

  it("renders nothing when there are no safe sources", () => {
    const sources: OraSource[] = [{ title: "Evil", url: "javascript:alert(1)" }];
    const { container } = render(<OraSourceCards sources={sources} />);
    expect(container.querySelector('[data-testid="ora-source-cards"]')).toBeNull();
  });
});
