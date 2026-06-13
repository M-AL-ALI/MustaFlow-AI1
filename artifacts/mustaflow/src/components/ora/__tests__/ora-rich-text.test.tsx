import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { OraRichText, parseOraSegments, isAppUrl } from "../ora-rich-text";

afterEach(() => cleanup());

describe("parseOraSegments", () => {
  it("parses a markdown link into a link segment with its label", () => {
    const segs = parseOraSegments("See [MustaFlow](https://mustaflow.app) for more.");
    const link = segs.find((s) => s.type === "link");
    expect(link).toMatchObject({ value: "MustaFlow", href: "https://mustaflow.app" });
  });

  it("auto-links a bare URL", () => {
    const segs = parseOraSegments("Go to https://example.com now");
    const link = segs.find((s) => s.type === "link");
    expect(link).toMatchObject({ href: "https://example.com" });
  });

  it("unwraps a backtick-wrapped URL into a link", () => {
    const segs = parseOraSegments("Visit `https://example.com` today");
    const link = segs.find((s) => s.type === "link");
    expect(link).toMatchObject({ href: "https://example.com" });
    // The literal backticks must not remain as visible text around the URL.
    expect(segs.every((s) => !s.value.includes("`https"))).toBe(true);
  });

  it("peels trailing punctuation off a bare URL", () => {
    const segs = parseOraSegments("Check https://example.com.");
    const link = segs.find((s) => s.type === "link");
    expect(link?.href).toBe("https://example.com");
    expect(segs.at(-1)).toMatchObject({ type: "text", value: "." });
  });
});

describe("isAppUrl", () => {
  it("treats platform subdomains as app URLs", () => {
    expect(isAppUrl("https://hosted.mustaflow.app/x")).toBe(true);
    expect(isAppUrl("https://abc.preview.mustaflow.app/")).toBe(true);
  });

  it("does not treat the bare marketing domain as an app URL", () => {
    expect(isAppUrl("https://mustaflow.app")).toBe(false);
    expect(isAppUrl("https://www.mustaflow.app/pricing")).toBe(false);
  });

  it("treats published/preview paths as app URLs", () => {
    expect(isAppUrl("https://example.com/api/p/my-slug/")).toBe(true);
    expect(isAppUrl("https://example.com/preview/index.html")).toBe(true);
  });
});

describe("OraRichText", () => {
  it("renders a safe link as a new-tab anchor", () => {
    const { container } = render(<OraRichText text="Open https://example.com please" />);
    const a = container.querySelector("a[href='https://example.com']");
    expect(a).not.toBeNull();
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders an app URL as an Open your app button", () => {
    const { container } = render(
      <OraRichText text="Your app is live at https://hosted.mustaflow.app/abc" />,
    );
    expect(container.textContent).toContain("Open your app");
    const a = container.querySelector("a[href='https://hosted.mustaflow.app/abc']");
    expect(a?.getAttribute("target")).toBe("_blank");
  });

  it("never turns an unsafe/localhost URL into a live link", () => {
    const { container } = render(<OraRichText text="debug at http://localhost:3000/x here" />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("http://localhost:3000/x");
  });

  it("provides a copy control next to a rendered link", () => {
    const { container } = render(<OraRichText text="Open https://example.com please" />);
    expect(container.querySelector("button[aria-label='Copy link']")).not.toBeNull();
  });

  it("renders common markdown formatting without exposing raw symbols", () => {
    const { container } = render(
      <OraRichText
        text={[
          "## Summary",
          "",
          "**Result:** Ora should answer directly.",
          "",
          "- Read the pasted text",
          "- Give the shortest useful reply",
        ].join("\n")}
      />,
    );

    expect(container.textContent).toContain("Summary");
    expect(container.textContent).toContain("Result:");
    expect(container.textContent).not.toContain("##");
    expect(container.textContent).not.toContain("**");
    expect(container.querySelector("strong")?.textContent).toBe("Result:");
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("renders markdown tables as tables instead of raw pipe text", () => {
    const { container } = render(
      <OraRichText
        text={[
          "| Area | Status |",
          "| --- | --- |",
          "| Routing | Pass |",
          "| Memory | Needs live auth |",
        ].join("\n")}
      />,
    );

    expect(container.querySelector("table")).not.toBeNull();
    expect(container.textContent).toContain("Routing");
    expect(container.textContent).toContain("Needs live auth");
    expect(container.textContent).not.toContain("| --- |");
  });
});
