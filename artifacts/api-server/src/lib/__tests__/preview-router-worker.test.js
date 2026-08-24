/* global Headers, Request, Response */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPreviewRelayHost,
  relayPreviewRequest,
} from "../../../../../infrastructure/cloudflare/preview-router-worker.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("B5 preview relay Worker", () => {
  it("matches only p-number preview hosts", () => {
    expect(isPreviewRelayHost("p52.preview.mustaflow.com")).toBe(true);
    expect(isPreviewRelayHost("P52.PREVIEW.MUSTAFLOW.COM")).toBe(true);
    expect(isPreviewRelayHost("x52.preview.mustaflow.com")).toBe(false);
    expect(isPreviewRelayHost("p52.preview.mustaflow.com.evil.test")).toBe(false);
  });

  it("returns the honest 404 without contacting origin for nonmatching hosts", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await relayPreviewRequest(
      new Request("https://preview.mustaflow.com/private"),
      { B5_RELAY_SECRET: "relay-secret" },
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Preview not found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves request semantics and overwrites public relay-header injection", async () => {
    const fetchMock = vi.fn(async () => new Response("origin-body", { status: 207 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await relayPreviewRequest(
      new Request("https://p52.preview.mustaflow.com/api/items?q=one", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "x-b5-preview-host": "forged.preview.mustaflow.com",
          "x-b5-relay-auth": "forged",
        },
        body: "payload",
      }),
      { B5_RELAY_SECRET: "relay-secret" },
    );

    expect(response.status).toBe(207);
    expect(await response.text()).toBe("origin-body");
    const [target, init] = fetchMock.mock.calls[0];
    expect(String(target)).toBe("https://musta-flow-ai.replit.app/api/b5-preview/api/items?q=one");
    expect(init.method).toBe("POST");
    expect(await new Response(init.body).text()).toBe("payload");
    const headers = new Headers(init.headers);
    expect(headers.get("x-b5-preview-host")).toBe("p52.preview.mustaflow.com");
    expect(headers.get("x-b5-preview-path")).toBe("/api/items?q=one");
    expect(headers.get("x-b5-relay-auth")).toBe("relay-secret");
  });

  it("preserves encoded public paths and overwrites a forged path assertion", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await relayPreviewRequest(
      new Request("https://p52.preview.mustaflow.com/assets/app%20name.js?q=a%2Fb&mark=%E2%9C%93", {
        headers: { "x-b5-preview-path": "/forged" },
      }),
      { B5_RELAY_SECRET: "relay-secret" },
    );

    const [target, init] = fetchMock.mock.calls[0];
    expect(String(target)).toBe(
      "https://musta-flow-ai.replit.app/api/b5-preview/assets/app%20name.js?q=a%2Fb&mark=%E2%9C%93",
    );
    expect(new Headers(init.headers).get("x-b5-preview-path")).toBe(
      "/assets/app%20name.js?q=a%2Fb&mark=%E2%9C%93",
    );
  });
});
