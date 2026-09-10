import { describe, expect, it, vi } from "vitest";
import { NabuflowSandbox } from "../src/runtime-backend";
import { forwardPreviewCaptureInSandbox } from "../src/preview-capture-sandbox";
import {
  PREVIEW_CAPTURE_FORWARD_ORIGIN,
  PREVIEW_CAPTURE_PORT_HEADER,
} from "../src/preview-capture-policy";

function headersRecord(headers?: HeadersInit): Record<string, string> {
  const result: Record<string, string> = {};
  new Headers(headers).forEach((value, name) => {
    result[name] = value;
  });
  return result;
}

function request(init: RequestInit = {}) {
  return new Request(PREVIEW_CAPTURE_FORWARD_ORIGIN + "/assets/main.css?v=1", {
    ...init,
    headers: {
      [PREVIEW_CAPTURE_PORT_HEADER]: "8080",
      ...headersRecord(init.headers),
    },
  });
}

describe("non-waking native capture forwarding", () => {
  function fixture(running = true, status = "healthy") {
    const fetch = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response("body { color: red }", { headers: { "content-type": "text/css" } }),
    );
    const getTcpPort = vi.fn(() => ({ fetch }) as unknown as Fetcher);
    const getState = vi.fn(async () => ({ status }));
    const container = { running, getTcpPort };
    const start = vi.fn();
    const startAndWaitForPorts = vi.fn();
    const containerFetch = vi.fn();
    const renewActivityTimeout = vi.fn();
    return {
      container,
      getState,
      fetch,
      getTcpPort,
      start,
      startAndWaitForPorts,
      containerFetch,
      renewActivityTimeout,
    };
  }

  it.each([
    [false, "stopped"],
    [true, "starting"],
    [true, "stopping"],
    [true, "unhealthy"],
  ])("does not wake or repair running=%s status=%s", async (running, status) => {
    const f = fixture(running, status);
    const response = await NabuflowSandbox.prototype.fetch.call(
      {
        ctx: { container: f.container },
        getState: f.getState,
        start: f.start,
        startAndWaitForPorts: f.startAndWaitForPorts,
        containerFetch: f.containerFetch,
        renewActivityTimeout: f.renewActivityTimeout,
      } as unknown as NabuflowSandbox,
      request(),
    );
    expect(response.status).toBe(503);
    expect(f.getTcpPort).not.toHaveBeenCalled();
    for (const method of [
      f.start,
      f.startAndWaitForPorts,
      f.containerFetch,
      f.renewActivityTimeout,
    ])
      expect(method).not.toHaveBeenCalled();
  });

  it("fails when the native container binding is absent", async () => {
    const state = vi.fn(async () => ({ status: "healthy" }));
    expect((await forwardPreviewCaptureInSandbox(undefined, state, request())).status).toBe(503);
    expect(state).not.toHaveBeenCalled();
  });

  it("uses only the manifest port native fetch with manual redirects and clean headers", async () => {
    const f = fixture();
    const response = await forwardPreviewCaptureInSandbox(
      f.container,
      f.getState,
      request({
        headers: {
          accept: "text/css",
          cookie: "__session=clerk; app=secret",
          authorization: "Bearer secret",
          "proxy-authorization": "secret",
          "x-nabuflow-preview-capture": "credential",
          "x-nabuflow-signature": "signature",
          "cf-container-target-port": "3000",
          forwarded: "host=other",
          "x-forwarded-host": "other",
          "x-api-key": "secret",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(f.getTcpPort).toHaveBeenCalledExactlyOnceWith(8080);
    const [url, init] = f.fetch.mock.calls[0];
    expect(url).toBe("http://tenant.preview.invalid/assets/main.css?v=1");
    expect(init?.redirect).toBe("manual");
    expect(headersRecord(init?.headers)).toEqual({
      accept: "text/css",
      "accept-encoding": "identity",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rechecks running after the health read and never retries a native failure", async () => {
    const f = fixture();
    f.getState.mockImplementation(async () => {
      f.container.running = false;
      return { status: "healthy" };
    });
    expect((await forwardPreviewCaptureInSandbox(f.container, f.getState, request())).status).toBe(
      503,
    );
    expect(f.fetch).not.toHaveBeenCalled();
    f.container.running = true;
    f.getState.mockResolvedValue({ status: "healthy" });
    f.fetch.mockRejectedValue(new Error("container stopped between check and native fetch"));
    expect((await forwardPreviewCaptureInSandbox(f.container, f.getState, request())).status).toBe(
      503,
    );
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.start).not.toHaveBeenCalled();
  });

  it.each<RequestInit>([
    { method: "POST" },
    { headers: { upgrade: "websocket" } },
    { headers: { accept: "text/event-stream" } },
    { headers: { [PREVIEW_CAPTURE_PORT_HEADER]: "3000" } },
    { headers: { [PREVIEW_CAPTURE_PORT_HEADER]: "80" } },
  ])("blocks invalid native forwarding input %j", async (init) => {
    const f = fixture();
    expect(
      (await forwardPreviewCaptureInSandbox(f.container, f.getState, request(init))).status,
    ).toBeGreaterThanOrEqual(400);
    expect(f.getState).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("does not follow an external redirect", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(Response.redirect("https://external.example/", 302));
    expect((await forwardPreviewCaptureInSandbox(f.container, f.getState, request())).status).toBe(
      302,
    );
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[0][1]?.redirect).toBe("manual");
  });
});
