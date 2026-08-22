import { describe, expect, it } from "vitest";
import { screenshotRequestHeaders } from "./agent-senses";

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
});
