import type { Browser, BrowserContext, Page, Route } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("playwright", () => ({ chromium: { launch: mock.launch } }));

import { takeScreenshot } from "./agent-senses";

const origin = "http://127.0.0.1:8181";
const path = "/api/projects/901/preview/";
const input = () => ({
  url: origin + path,
  signal: new AbortController().signal,
  exactCookieOrigin: origin,
  exactCookiePath: path,
  exactOriginCookies: [{ name: "__session", value: "fixture-only-opaque" }],
  trustedLoopbackOrigin: origin,
});

let browser: Browser;
let context: BrowserContext;
let page: Page;
let handler: (route: Route) => Promise<void>;

beforeEach(() => {
  vi.resetAllMocks();
  page = {
    goto: vi.fn(async () => ({ status: () => 200 })),
    setContent: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => Buffer.from("fixture-png")),
    url: vi.fn(() => origin + path),
    on: vi.fn(),
  } as unknown as Page;
  context = {
    route: vi.fn(async (_pattern: string, callback: (route: Route) => Promise<void>) => {
      handler = callback;
    }),
    routeWebSocket: vi.fn(async () => undefined),
    setDefaultTimeout: vi.fn(),
    newPage: vi.fn(async () => page),
    addCookies: vi.fn(),
  } as unknown as BrowserContext;
  browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  } as unknown as Browser;
  mock.launch.mockResolvedValue(browser);
});
afterEach(() => vi.unstubAllGlobals());

describe("capture browser isolation and cancellation", () => {
  it("uses a fresh, cookie-free browser with context-wide interception and no service workers", async () => {
    const result = await takeScreenshot(input());
    expect(result.ok).toBe(true);
    expect(context.addCookies).not.toHaveBeenCalled();
    expect(browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceWorkers: "block",
        acceptDownloads: false,
        javaScriptEnabled: true,
      }),
    );
    expect(context.route).toHaveBeenCalledWith("**/*", expect.any(Function));
    expect(context.routeWebSocket).toHaveBeenCalledWith("**/*", expect.any(Function));
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("rejects missing project scope before starting Chromium", async () => {
    const result = await takeScreenshot({ ...input(), exactCookiePath: undefined });
    expect(result.ok).toBe(false);
    expect(mock.launch).not.toHaveBeenCalled();
  });

  it("does not start an already-cancelled capture", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await takeScreenshot({ ...input(), signal: controller.signal })).toEqual({
      ok: false,
      error: "capture cancelled",
    });
    expect(mock.launch).not.toHaveBeenCalled();
  });

  it("closes a browser that finishes launching after cancellation and never retries", async () => {
    const controller = new AbortController();
    mock.launch.mockImplementation(async () => {
      controller.abort();
      return browser;
    });
    const result = await takeScreenshot({ ...input(), signal: controller.signal });
    expect(result).toEqual({ ok: false, error: "capture cancelled" });
    expect(mock.launch).toHaveBeenCalledOnce();
    expect(browser.newContext).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("cancels navigation, closes once and never returns a late screenshot", async () => {
    const controller = new AbortController();
    let rejectNavigation: (error: Error) => void = () => undefined;
    vi.mocked(browser.close).mockImplementation(async () => {
      rejectNavigation(new Error("browser closed"));
    });
    vi.mocked(page.goto).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectNavigation = reject;
          controller.abort();
        }),
    );
    const result = await takeScreenshot({ ...input(), signal: controller.signal });
    expect(result).toEqual({ ok: false, error: "capture cancelled" });
    expect(browser.close).toHaveBeenCalledOnce();
    expect(page.screenshot).not.toHaveBeenCalled();
  });

  it("blocks a cross-project request from any intercepted page before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const abort = vi.fn(async () => undefined);
    vi.mocked(page.goto).mockImplementation(async () => {
      await handler({
        request: () => ({
          url: () => origin + "/api/projects/902/preview/",
          method: () => "GET",
        }),
        abort,
      } as unknown as Route);
      return { status: () => 200 } as never;
    });
    await takeScreenshot(input());
    expect(abort).toHaveBeenCalledWith("blockedbyclient");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps ordinary inline static captures working without JavaScript or credentials", async () => {
    const result = await takeScreenshot({
      url: "",
      inlineHtml: "<h1>Project</h1>",
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    expect(page.setContent).toHaveBeenCalledWith("<h1>Project</h1>", expect.any(Object));
    expect(page.goto).not.toHaveBeenCalled();
    expect(context.addCookies).not.toHaveBeenCalled();
    expect(browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ javaScriptEnabled: false }),
    );
  });

  it("closes the browser if page capture fails", async () => {
    vi.mocked(page.screenshot).mockRejectedValue(new Error("fixture failure"));
    const result = await takeScreenshot(input());
    expect(result.ok).toBe(false);
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
