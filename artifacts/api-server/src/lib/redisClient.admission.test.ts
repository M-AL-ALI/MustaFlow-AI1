import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;

async function loadClient(configured = true) {
  vi.resetModules();
  if (configured) {
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.invalid";
    process.env.UPSTASH_REDIS_REST_TOKEN = "runtime-only-test-token";
  } else {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
  return import("./redisClient");
}

describe("atomic dual-window Redis admission", () => {
  beforeEach(() => vi.restoreAllMocks());

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  });

  it("uses Redis server time and decides both windows before writing either counter", async () => {
    const { RESERVE_DUAL_WINDOW_LUA } = await loadClient();
    const firstWrite = RESERVE_DUAL_WINDOW_LUA.indexOf("redis.call('HSET'");

    expect(RESERVE_DUAL_WINDOW_LUA).toContain("redis.call('TIME')");
    expect(RESERVE_DUAL_WINDOW_LUA.indexOf("if nextHour >")).toBeLessThan(firstWrite);
    expect(RESERVE_DUAL_WINDOW_LUA.indexOf("if nextDay >")).toBeLessThan(firstWrite);
    expect(RESERVE_DUAL_WINDOW_LUA).not.toContain("Date.now");
  });

  it("dispatches one EVAL and maps an allowed reservation", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ result: [1, 0, 12, 41, 1_800_003_600, 1_800_057_600, 1_800_000_001] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const { reserveDualWindowAdmission } = await loadClient();

    await expect(
      reserveDualWindowAdmission({
        key: "account-key",
        hourlyLimit: 60,
        dailyLimit: 200,
        weight: 2,
      }),
    ).resolves.toEqual({
      allowed: true,
      blockedWindow: null,
      hourCount: 12,
      dayCount: 41,
      hourResetAtMs: 1_800_003_600_000,
      dayResetAtMs: 1_800_057_600_000,
      serverNowMs: 1_800_000_001_000,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as unknown[];
    expect(body.slice(0, 3)).toEqual(["EVAL", expect.stringContaining("redis.call('TIME')"), 1]);
    expect(body.slice(-4)).toEqual(["account-key", 60, 200, 2]);
    const { registry } = await import("./metrics");
    await expect(
      registry.getSingleMetricAsString("redis_admission_backend_available"),
    ).resolves.toContain("redis_admission_backend_available 1");
  });

  it("returns an honest day rejection without advancing either count", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ result: [0, 2, 59, 200, 1_800_003_600, 1_800_057_600, 1_800_000_001] }),
        {
          status: 200,
        },
      ),
    );
    const { reserveDualWindowAdmission } = await loadClient();

    await expect(
      reserveDualWindowAdmission({
        key: "account-key",
        hourlyLimit: 60,
        dailyLimit: 200,
        weight: 1,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      blockedWindow: "day",
      hourCount: 59,
      dayCount: 200,
    });
  });

  it("fails closed before dispatch when bindings are missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { reserveDualWindowAdmission } = await loadClient(false);

    await expect(
      reserveDualWindowAdmission({
        key: "anonymous-ip",
        hourlyLimit: 60,
        dailyLimit: 200,
        weight: 1,
      }),
    ).rejects.toThrow("Redis not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
    const { registry } = await import("./metrics");
    await expect(
      registry.getSingleMetricAsString("redis_admission_backend_available"),
    ).resolves.toContain("redis_admission_backend_available 0");
  });

  it.each([
    ["transport", () => Promise.reject(new TypeError("offline"))],
    ["http", () => Promise.resolve(new Response("unavailable", { status: 503 }))],
    [
      "shape",
      () => Promise.resolve(new Response(JSON.stringify({ result: [1, 0] }), { status: 200 })),
    ],
  ])("surfaces %s failures to fail-closed callers", async (_kind, response) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(response as typeof fetch);
    const { reserveDualWindowAdmission } = await loadClient();

    await expect(
      reserveDualWindowAdmission({
        key: "account-key",
        hourlyLimit: 60,
        dailyLimit: 200,
        weight: 1,
      }),
    ).rejects.toBeDefined();
  });

  it("emits one sanitized warning for the existing memory fallback", async () => {
    const client = await loadClient();
    const { logger } = await import("./logger");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    client.noteRedisFallback(new Error("https://private.invalid/secret-fragment"));
    client.noteRedisFallback(new TypeError("second-private-detail"));

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      { errorClass: "Error" },
      "Redis rate-limit backend unavailable — falling back to in-memory",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-fragment");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("second-private-detail");
  });
});
