import type { Route } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fulfillScreenshotPreview,
  isScreenshotPreviewRequest,
  screenshotPreviewScope,
} from "./screenshot-preview-bridge";

const origin = "http://127.0.0.1:8181";
const path = "/api/projects/901/preview/";
const input = {
  url: origin + path,
  exactCookieOrigin: origin,
  exactCookiePath: path,
  exactOriginCookies: [{ name: "__session", value: "fixture-only-opaque" }],
};
const scope = screenshotPreviewScope(input)!;

afterEach(() => vi.unstubAllGlobals());

function route(url = input.url, method = "GET") {
  return {
    request: () => ({
      url: () => url,
      method: () => method,
      allHeaders: async () => ({
        accept: "text/html",
        cookie: "page=untrusted",
        authorization: "page-token",
      }),
    }),
    abort: vi.fn(async () => undefined),
    fulfill: vi.fn(async () => undefined),
  };
}

describe("server-only screenshot credential boundary", () => {
  it.each([
    origin + "/api/admin/me",
    origin + "/api/projects/902/preview/",
    origin + path + "../secrets",
    origin + path + "%2e%2e/secrets",
    origin + path + "%252e%252e/secrets",
    origin + path + "%2f..%2fsecrets",
    origin + path + "%5c..%5csecrets",
    "http://127.0.0.1:8182" + path,
    "https://outside.example.test/" + path,
    "http://user:password@127.0.0.1:8181" + path,
    "invalid URL",
  ])("rejects an unapproved representation %s", (url) => {
    expect(isScreenshotPreviewRequest(url, scope)).toBe(false);
  });

  it("preserves selected-project paths, Arabic filenames, query strings and anchors", () => {
    expect(
      isScreenshotPreviewRequest(origin + path + "%D8%B5%D9%88%D8%B1%D8%A9.png?q=a%2Fb#top", scope),
    ).toBe(true);
    expect(isScreenshotPreviewRequest(origin + path + "assets/app%20name.js", scope)).toBe(true);
  });

  it.each([
    { exactCookiePath: undefined },
    { exactCookiePath: "/" },
    { exactCookiePath: "/api/projects/0/preview/" },
    { exactCookiePath: "/api/projects/9007199254740992/preview/" },
    { exactCookieOrigin: origin + "/" },
    { exactCookieOrigin: "bad-origin" },
    { inlineHtml: "<p>untrusted</p>" },
    { exactOriginCookies: [{ name: "unrelated", value: "opaque" }] },
    { exactOriginCookies: [{ name: "__session", value: "opaque; injected=1" }] },
  ])("fails closed before launch for invalid credential configuration %#", (override) => {
    expect(() => screenshotPreviewScope({ ...input, ...override })).toThrow();
  });

  it("needs no platform scope for an anonymous or Cloudflare-grant capture", () => {
    expect(
      screenshotPreviewScope({ url: "https://runtime.example.test/?__nfg=fixture" }),
    ).toBeNull();
  });

  it("authenticates only the server fetch and never returns Set-Cookie to the browser", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("<main>Project preview</main>", {
          headers: {
            "set-cookie": "__session=rotated-fixture; HttpOnly",
            "content-type": "text/html",
            "content-encoding": "gzip",
            "content-length": "999",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const target = route();
    const signal = new AbortController().signal;
    await fulfillScreenshotPreview(target as unknown as Route, scope, signal, { remaining: 1024 });

    expect(fetchMock).toHaveBeenCalledWith(
      input.url,
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          accept: "text/html",
          "accept-language": "en",
          cookie: "__session=fixture-only-opaque",
        },
      }),
    );
    expect(target.fulfill).toHaveBeenCalledWith({
      status: 200,
      headers: { "content-type": "text/html", "cache-control": "no-store" },
      body: Buffer.from("<main>Project preview</main>"),
    });
    expect(target.abort).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "DELETE", "PATCH"])(
    "does not authorize %s mutations while taking a screenshot",
    async (method) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const target = route(input.url, method);
      await fulfillScreenshotPreview(
        target as unknown as Route,
        scope,
        new AbortController().signal,
        { remaining: 1024 },
      );
      expect(target.abort).toHaveBeenCalledWith("blockedbyclient");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects another project before a network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const target = route(origin + "/api/projects/902/preview/");
    await fulfillScreenshotPreview(
      target as unknown as Route,
      scope,
      new AbortController().signal,
      { remaining: 1024 },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(target.abort).toHaveBeenCalledOnce();
  });

  it("never follows an external or cross-project redirect with a session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "/api/projects/902/preview/" },
          }),
      ),
    );
    const target = route();
    await expect(
      fulfillScreenshotPreview(target as unknown as Route, scope, new AbortController().signal, {
        remaining: 1024,
      }),
    ).rejects.toThrow("redirect left");
    expect(target.fulfill).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves a redirect inside the selected preview without following it server-side", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: path + "dashboard" },
          }),
      ),
    );
    const target = route();
    await fulfillScreenshotPreview(
      target as unknown as Route,
      scope,
      new AbortController().signal,
      { remaining: 1024 },
    );
    expect(target.fulfill).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 302,
        headers: expect.objectContaining({ location: path + "dashboard" }),
      }),
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("bounds response bytes before fulfilling the browser request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("too-large")),
    );
    const target = route();
    await expect(
      fulfillScreenshotPreview(target as unknown as Route, scope, new AbortController().signal, {
        remaining: 3,
      }),
    ).rejects.toThrow("budget exceeded");
    expect(target.fulfill).not.toHaveBeenCalled();
  });
});
