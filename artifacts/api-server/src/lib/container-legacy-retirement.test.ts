import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegacyFlyRetirementRequest } from "./project-retirement-legacy-fly";

const source = readFileSync(new URL("./container.ts", import.meta.url), "utf8");
const start = source.indexOf("export async function requestLegacyFlyMachineForRetirement(");
const end = source.indexOf("function machineProxyUrl(", start);
const adapter = source.slice(start, end);

describe("legacy retirement fixed-app adapter contract", () => {
  it("uses only fixed-app inventory and encoded exact-machine paths", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(adapter).toContain('input.resource === "volumes"');
    expect(adapter).toContain("`/apps/${encodeURIComponent(FLY_APP)}/volumes`");
    expect(adapter).toContain(
      "`/apps/${encodeURIComponent(FLY_APP)}/machines/${encodeURIComponent(",
    );
    expect(adapter).toContain("input.machineId,");
    expect(adapter).not.toMatch(/input\.(?:url|app|path|cursor|page)/u);
  });

  it("bounds both request paths and never forces or redirects a machine delete", () => {
    expect(adapter.match(/10_000/gu)).toHaveLength(2);
    expect(adapter.match(/redirect: "error"/gu)).toHaveLength(2);
    expect(adapter).toContain('input.resource === "lease" ? machinePath + "/lease" : machinePath');
    expect(adapter).toContain("method: input.method");
    expect(adapter).not.toContain("force=true");
    expect(adapter).not.toContain("destroyContainer(");
    expect(adapter).toContain('input.resource === "wait" ? 20_000 : 10_000');
    expect(adapter).not.toMatch(/\/(?:start|restart|suspend|exec)(?:["?`/]|$)/u);
  });
});

const transport = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  withRetry: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: {},
  projectsTable: {},
  containerLogsTable: {},
}));
vi.mock("./logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("./resilience", () => ({
  containerCircuit: { call: (run: () => Promise<unknown>) => run() },
  withRetry: transport.withRetry,
  isTransientError: () => true,
}));

describe("legacy retirement lease transport", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("FLY_API_TOKEN", "test-only-token");
    vi.stubEnv("FLY_APP_NAME", "retirement-test-app");
    transport.fetch.mockReset();
    transport.withRetry
      .mockReset()
      .mockImplementation(async (run: () => Promise<unknown>, options: { maxAttempts: number }) => {
        for (let attempt = 1; ; attempt++) {
          try {
            return await run();
          } catch (error) {
            if (attempt >= options.maxAttempts) throw error;
          }
        }
      });
    vi.stubGlobal("fetch", transport.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const mutations: Array<Parameters<LegacyFlyRetirementRequest>[0]> = [
    {
      resource: "lease",
      machineId: "test-machine",
      method: "POST",
      description: "Legacy runtime retirement",
      ttl: 300,
    },
    { machineId: "test-machine", method: "DELETE", leaseNonce: "test-private-nonce" },
    {
      resource: "stop",
      machineId: "test-machine",
      method: "POST",
      leaseNonce: "test-private-nonce",
    },
    {
      resource: "lease",
      machineId: "test-machine",
      method: "DELETE",
      leaseNonce: "test-private-nonce",
    },
  ];

  it.each(mutations)("uses the fixed path and one attempt for $method $resource", async (input) => {
    const { requestLegacyFlyMachineForRetirement } = await import("./container");
    transport.fetch.mockResolvedValue(
      new Response(null, { status: input.method === "POST" ? 201 : 204 }),
    );

    await requestLegacyFlyMachineForRetirement(input);

    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(transport.withRetry).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ maxAttempts: 1 }),
    );
    const [url, init] = transport.fetch.mock.calls[0]!;
    expect(url).toBe(
      "https://api.machines.dev/v1/apps/retirement-test-app/machines/test-machine" +
        (input.resource === "lease" ? "/lease" : input.resource === "stop" ? "/stop" : ""),
    );
    expect(init?.method).toBe(input.method);
    expect(init?.redirect).toBe("error");
    expect(String(url)).not.toContain("force");
    const headers = new Headers(init?.headers);
    if (input.resource === "lease" && input.method === "POST") {
      expect(JSON.parse(init?.body as string)).toEqual({
        description: "Legacy runtime retirement",
        ttl: 300,
      });
      expect(headers.has("fly-machine-lease-nonce")).toBe(false);
    } else {
      expect(headers.get("fly-machine-lease-nonce")).toBe("test-private-nonce");
      expect(init?.body).toBeUndefined();
    }
  });

  it.each(mutations)("does not retry a transient $method $resource failure", async (input) => {
    const { requestLegacyFlyMachineForRetirement } = await import("./container");
    transport.fetch.mockResolvedValue(new Response("provider-secret", { status: 503 }));
    await expect(requestLegacyFlyMachineForRetirement(input)).rejects.toThrow("Fly.io 503");
    expect(transport.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(mutations)("does not retry a transport failure for $method $resource", async (input) => {
    const { requestLegacyFlyMachineForRetirement } = await import("./container");
    transport.fetch.mockRejectedValue(new Error("test transport failed"));
    await expect(requestLegacyFlyMachineForRetirement(input)).rejects.toThrow(
      "test transport failed",
    );
    expect(transport.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps bounded GET retries and the original default for unrelated callers", async () => {
    const { requestLegacyFlyMachineForRetirement } = await import("./container");
    transport.fetch
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));
    await requestLegacyFlyMachineForRetirement({ resource: "volumes", method: "GET" });
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    expect(transport.withRetry).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ maxAttempts: 3 }),
    );
    expect(source).toContain("maxAttempts = 3,");
  });

  it("encodes exact machine identifiers and includes the nonce on GET", async () => {
    const { requestLegacyFlyMachineForRetirement } = await import("./container");
    transport.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await requestLegacyFlyMachineForRetirement({
      machineId: "test/machine?query",
      method: "GET",
      leaseNonce: "test-private-nonce",
    });
    const [url, init] = transport.fetch.mock.calls[0]!;
    expect(url).toBe(
      "https://api.machines.dev/v1/apps/retirement-test-app/machines/test%2Fmachine%3Fquery",
    );
    expect(new Headers(init?.headers).get("fly-machine-lease-nonce")).toBe("test-private-nonce");
  });

  it("refuses missing nonce and unbounded TTL before fetch", async () => {
    const { requestLegacyFlyMachineForRetirement } = await import("./container");
    await expect(
      requestLegacyFlyMachineForRetirement({
        machineId: "test-machine",
        method: "DELETE",
      } as Parameters<LegacyFlyRetirementRequest>[0]),
    ).rejects.toThrow("Invalid retirement machine lease");
    await expect(
      requestLegacyFlyMachineForRetirement({
        resource: "lease",
        machineId: "test-machine",
        method: "POST",
        description: "test",
        ttl: 301,
      }),
    ).rejects.toThrow("Invalid retirement machine lease");
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  const instanceId = "A".repeat(26);

  it("pins the stopped wait to the observed version with one bounded attempt", async () => {
    const { requestLegacyFlyMachineForRetirement } = await import("./container");
    transport.fetch.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const deadline = vi.spyOn(AbortSignal, "timeout");
    try {
      await requestLegacyFlyMachineForRetirement({
        resource: "wait",
        machineId: "test-machine",
        method: "GET",
        instanceId,
        leaseNonce: "test-private-nonce",
      });
      const [url, init] = transport.fetch.mock.calls[0]!;
      expect(url).toBe(
        "https://api.machines.dev/v1/apps/retirement-test-app/machines/test-machine" +
          "/wait?state=stopped&version=" +
          instanceId +
          "&timeout=15",
      );
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get("fly-machine-lease-nonce")).toBe("test-private-nonce");
      expect(deadline).toHaveBeenCalledWith(20_000);
      expect(transport.withRetry).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ maxAttempts: 1 }),
      );
    } finally {
      deadline.mockRestore();
    }
  });

  it.each(["stop", "wait"] as const)("does not retry an aborted %s request", async (resource) => {
    const { requestLegacyFlyMachineForRetirement } = await import("./container");
    const controller = new AbortController();
    const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    transport.fetch.mockImplementation(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort(new Error("bounded-timeout"));
      init?.signal?.throwIfAborted();
      throw new Error("Expected aborted request");
    });
    try {
      const input: Parameters<LegacyFlyRetirementRequest>[0] =
        resource === "stop"
          ? {
              resource,
              method: "POST",
              machineId: "test-machine",
              leaseNonce: "test-private-nonce",
            }
          : {
              resource,
              method: "GET",
              machineId: "test-machine",
              leaseNonce: "test-private-nonce",
              instanceId,
            };
      await expect(requestLegacyFlyMachineForRetirement(input)).rejects.toThrow("bounded-timeout");
      expect(deadline).toHaveBeenCalledWith(resource === "wait" ? 20_000 : 10_000);
      expect(transport.fetch).toHaveBeenCalledTimes(1);
    } finally {
      deadline.mockRestore();
    }
  });

  it.each([408, 503])("does not repeat a failed stopped wait (%s)", async (status) => {
    const { requestLegacyFlyMachineForRetirement } = await import("./container");
    transport.fetch.mockResolvedValue(new Response(null, { status }));
    const pending = requestLegacyFlyMachineForRetirement({
      resource: "wait",
      method: "GET",
      machineId: "test-machine",
      leaseNonce: "test-private-nonce",
      instanceId,
    });
    if (status === 503) await expect(pending).rejects.toThrow("Fly.io 503");
    else expect((await pending).status).toBe(408);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { resource: "stop", method: "POST" },
    { resource: "stop", method: "POST", leaseNonce: "bad\r\nnonce" },
    { resource: "wait", method: "GET", instanceId },
    {
      resource: "wait",
      method: "GET",
      leaseNonce: "test-private-nonce",
      instanceId: "bad?version",
    },
    {
      resource: "wait",
      method: "GET",
      leaseNonce: "test-private-nonce",
      instanceId: "A".repeat(27),
    },
    { resource: "wait", method: "GET", leaseNonce: "test-private-nonce", instanceId: null },
    { resource: "start", method: "POST", leaseNonce: "test-private-nonce" },
    { resource: "restart", method: "POST", leaseNonce: "test-private-nonce" },
    { resource: "suspend", method: "POST", leaseNonce: "test-private-nonce" },
    { resource: "stop", method: "GET", leaseNonce: "test-private-nonce" },
    { resource: "volumes", method: "DELETE", leaseNonce: "test-private-nonce" },
    { method: "POST", leaseNonce: "test-private-nonce" },
  ])("rejects unsafe runtime input before fetch: %j", async (input) => {
    const { requestLegacyFlyMachineForRetirement } = await import("./container");
    await expect(
      requestLegacyFlyMachineForRetirement({
        ...input,
        machineId: "test-machine",
      } as Parameters<LegacyFlyRetirementRequest>[0]),
    ).rejects.toThrow();
    expect(transport.fetch).not.toHaveBeenCalled();
  });
});
