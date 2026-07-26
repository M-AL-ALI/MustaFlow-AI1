import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
  lookup: lookupMock,
}));

vi.mock("@workspace/db", () => ({
  db: {},
  projectsTable: {},
  containerLogsTable: {},
}));

describe("operational Fly container capability", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    vi.stubEnv("FLY_API_TOKEN", "test-token");
    vi.stubEnv("FLY_APP_NAME", "mustaflow-containers");
    lookupMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("fails closed without credentials and performs no probes", async () => {
    vi.stubEnv("FLY_API_TOKEN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { isContainerLayerConfigured } = await import("./container");

    await expect(isContainerLayerConfigured()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("fails closed when the proxy hostname does not resolve", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    lookupMock.mockRejectedValue(new Error("dns unavailable"));

    const { isContainerLayerConfigured } = await import("./container");

    await expect(isContainerLayerConfigured()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lookupMock).toHaveBeenCalledWith("mustaflow-containers.fly.dev");
  });

  it("fails closed when the authenticated control-plane probe fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    lookupMock.mockResolvedValue({ address: "192.0.2.1", family: 4 });

    const { isContainerLayerConfigured } = await import("./container");

    await expect(isContainerLayerConfigured()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a probe times out", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    lookupMock.mockResolvedValue({ address: "192.0.2.1", family: 4 });

    const { isContainerLayerConfigured } = await import("./container");
    const result = isContainerLayerConfigured();
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(result).resolves.toBe(false);
  });

  it("caches a negative result for at least 60 seconds", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-07-26T12:00:00.000Z");
    vi.setSystemTime(startedAt);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    lookupMock.mockRejectedValue(new Error("dns unavailable"));

    const { isContainerLayerConfigured } = await import("./container");

    await expect(isContainerLayerConfigured()).resolves.toBe(false);
    vi.setSystemTime(new Date(startedAt.getTime() + 59_999));
    await expect(isContainerLayerConfigured()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lookupMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    lookupMock.mockResolvedValue({ address: "192.0.2.1", family: 4 });
    vi.setSystemTime(new Date(startedAt.getTime() + 60_001));
    await expect(isContainerLayerConfigured()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lookupMock).toHaveBeenCalledTimes(2);
  });

  it("reports operational only when both read-only probes succeed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    lookupMock.mockResolvedValue({ address: "192.0.2.1", family: 4 });

    const { isContainerLayerConfigured } = await import("./container");

    await expect(isContainerLayerConfigured()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.machines.dev/v1/apps/mustaflow-containers/machines",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
