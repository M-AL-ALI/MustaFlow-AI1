import { describe, expect, it } from "vitest";
import { resolveClerkProxyUrl } from "./clerk-proxy-url";

describe("resolveClerkProxyUrl", () => {
  it("keeps the first-party Clerk proxy on canonical production", () => {
    expect(resolveClerkProxyUrl("www.mustaflow.com", "/api/__clerk")).toBe("/api/__clerk");
  });

  it("uses Clerk directly on Replit database-change preview hosts", () => {
    expect(
      resolveClerkProxyUrl(
        "862972c9-fbc6-4d7f-b1bb-603b40d56139.kirk.prod.repl.run",
        "/api/__clerk",
      ),
    ).toBeUndefined();
  });

  it("does not mistake a suffix lookalike for a Replit preview host", () => {
    expect(resolveClerkProxyUrl("kirk.prod.repl.run.example.test", "/api/__clerk")).toBe(
      "/api/__clerk",
    );
  });

  it("normalizes host casing and a trailing DNS dot", () => {
    expect(resolveClerkProxyUrl("EXAMPLE.KIRK.PROD.REPL.RUN.", "/api/__clerk")).toBeUndefined();
  });

  it("omits the proxy when none is configured", () => {
    expect(resolveClerkProxyUrl("www.mustaflow.com", "  ")).toBeUndefined();
  });
});
