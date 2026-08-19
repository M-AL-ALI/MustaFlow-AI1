import { afterEach, describe, expect, it, vi } from "vitest";

const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;

async function loadClient(configured: boolean) {
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

describe("existing distributed rate-limit fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  });

  it("reports a healthy backend after a successful fixed-window command", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: 1 }), { status: 200 }));
    const client = await loadClient(true);

    await expect(client.redisIncrementWindow("rl:test:1", 60_000)).resolves.toBe(1);

    const { registry } = await import("./metrics");
    await expect(
      registry.getSingleMetricAsString("redis_rate_limit_backend_available"),
    ).resolves.toContain("redis_rate_limit_backend_available 1");
  });

  it("reports memory-fallback state when Redis is missing", async () => {
    const client = await loadClient(false);

    expect(client.isRedisEnabled()).toBe(false);
    const { registry } = await import("./metrics");
    await expect(
      registry.getSingleMetricAsString("redis_rate_limit_backend_available"),
    ).resolves.toContain("redis_rate_limit_backend_available 0");
  });

  it("logs only one sanitized fallback warning", async () => {
    const client = await loadClient(true);
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
