import { describe, expect, it } from "vitest";
import { sanitizeCaptureConsoleError, screenshotRequestHeaders } from "./agent-senses";

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
});
