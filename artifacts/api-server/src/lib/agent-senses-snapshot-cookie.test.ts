import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sanitizeCaptureConsoleError, screenshotRequestHeaders } from "./agent-senses";

const dir = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(dir, "agent-senses.ts"), "utf8");

describe("snapshot cookie cage", () => {
  it("keeps the session cookie on the exact platform origin", () => {
    expect(
      screenshotRequestHeaders(
        "https://www.mustaflow.com/api/projects/51/preview/",
        { cookie: "__session=opaque", accept: "text/html" },
        "https://www.mustaflow.com",
      ),
    ).toEqual({ cookie: "__session=opaque", accept: "text/html" });
  });

  it("removes Cookie from every external subresource request", () => {
    expect(
      screenshotRequestHeaders(
        "https://cdn.example.test/logo.png",
        { Cookie: "__session=opaque", accept: "image/png" },
        "https://www.mustaflow.com",
      ),
    ).toEqual({ accept: "image/png" });
  });

  it("removes private values before console evidence crosses the capture boundary", () => {
    const sanitized = sanitizeCaptureConsoleError(
      "Request failed for founder@example.com?token=abcdefghijklmnopqrstuvwxyz012345",
    );
    expect(sanitized).toContain("[private email]");
    expect(sanitized).toContain("token=[private value]");
    expect(sanitized).not.toContain("founder@example.com");
    expect(sanitized).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
  });

  it("keeps page overlays independent of ambient browser declarations", () => {
    expect(source).toContain("type OverlayDocument");
    expect(source).not.toContain("document: Document");
  });
});
