import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let cloudflare: typeof import("./cloudflare");
const originalEnv = { ...process.env };

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:1/test";
  cloudflare = await import("./cloudflare");
});

beforeEach(() => {
  process.env.CF_ACCOUNT_ID = "test-account";
  process.env.CF_KV_NAMESPACE_ID = "test-kv";
  process.env.CF_ZONE_ID = "test-zone";
  process.env.CF_API_TOKEN = "test-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

describe("strict Cloudflare retirement proofs", () => {
  const route = {
    projectId: 51,
    versionId: 7,
    versionHistory: [6],
    maintenance: false,
    preferredRegion: null,
  };

  it("needs no Cloudflare binding to prove an empty cache target set", async () => {
    delete process.env.CF_ACCOUNT_ID;
    delete process.env.CF_API_TOKEN;
    delete process.env.CF_KV_NAMESPACE_ID;
    delete process.env.CF_ZONE_ID;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloudflare.purgeCacheForHostnames([])).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call a failed KV deletion verified", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(route))
        .mockResolvedValueOnce(Response.json(route))
        .mockResolvedValueOnce(new Response(null, { status: 503 })),
    );

    await expect(cloudflare.retireHostnameKV("example.test")).resolves.toEqual({
      state: "unavailable",
      stage: "delete",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not mistake an ambiguous KV read for absence", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(route))
        .mockResolvedValueOnce(Response.json(route))
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(new Response(null, { status: 502 })),
    );

    await expect(cloudflare.retireHostnameKV("example.test")).resolves.toEqual({
      state: "unavailable",
      stage: "read",
    });
  });

  it("requires an authoritative 404 before a KV route is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(route))
        .mockResolvedValueOnce(Response.json(route))
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(new Response(null, { status: 404 })),
    );

    await expect(cloudflare.retireHostnameKV("example.test")).resolves.toEqual({
      state: "absent",
    });
  });

  it("does not call a custom-hostname certificate released after an ambiguous read", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(new Response(null, { status: 500 })),
    );

    await expect(cloudflare.retireCustomHostname("provider-hostname-id")).resolves.toEqual({
      state: "unavailable",
      stage: "read",
    });
  });

  it("does not call a failed custom-hostname deletion released", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await expect(cloudflare.retireCustomHostname("provider-hostname-id")).resolves.toEqual({
      state: "unavailable",
      stage: "delete",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("requires an authoritative 404 before a custom-hostname certificate is released", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(new Response(null, { status: 404 })),
    );

    await expect(cloudflare.retireCustomHostname("provider-hostname-id")).resolves.toEqual({
      state: "absent",
    });
  });

  it("strictly deletes and reads a tracked firewall resource", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(new Response(null, { status: 404 })),
    );

    await expect(
      cloudflare.retireCloudflareSecurityResource({
        kind: "firewall_rule",
        id: "rule-id",
        ref: "stable-ref",
      }),
    ).resolves.toEqual({ state: "absent" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reconciles an ambiguous default-WAF create by stable ref without a second POST", async () => {
    let stableRef = "";
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({ success: true, result: { id: "ruleset-id", rules: [] } }),
          { status: 200 },
        );
      }
      if (init?.method === "POST") {
        stableRef = (JSON.parse(String(init.body)) as { ref: string }).ref;
        throw new Error("ambiguous-after-commit");
      }
      return new Response(
        JSON.stringify({
          success: true,
          result: { id: "ruleset-id", rules: [{ id: "rule-id", ref: stableRef }] },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await cloudflare.applyDefaultWafRules("example.test", "hostname-id");
    expect(result).toEqual({
      state: "applied",
      resources: [
        {
          kind: "ruleset_rule",
          id: "rule-id",
          rulesetId: "ruleset-id",
          ref: stableRef,
        },
      ],
    });
    expect(fetchMock.mock.calls.filter((entry) => entry[1]?.method === "POST")).toHaveLength(1);
  });

  it("does not append a rule when the pre-create reconciliation read is ambiguous", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloudflare.applyDefaultWafRules("example.test", "hostname-id")).resolves.toEqual({
      state: "unavailable",
      resources: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
  });

  it("bounds cache purge payloads and sends chunks sequentially", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ success: true, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const hostnames = Array.from({ length: 31 }, (_, index) => `host-${index}.example.test`);
    await expect(cloudflare.purgeCacheForHostnames(hostnames)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      const payload = JSON.parse(String(init.body)) as { tags: string[] };
      expect(payload.tags.length).toBeLessThanOrEqual(30);
      expect(payload.tags.every((tag) => tag.startsWith("nabuflow-host-"))).toBe(true);
    }
  });

  it("inventories overwritten hostname history by project id", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/keys?")) {
        return Response.json({
          success: true,
          result: [
            { name: "old-slug.example.test" },
            { name: "current-slug.example.test" },
            { name: "other.example.test" },
          ],
          result_info: {},
        });
      }
      const hostname = decodeURIComponent(url.split("/values/")[1] ?? "");
      return Response.json({
        ...route,
        projectId: hostname === "other.example.test" ? 99 : 51,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloudflare.inventoryHostnameKVRoutesByProject(51)).resolves.toEqual({
      state: "complete",
      observations: [
        { hostname: "old-slug.example.test", route },
        { hostname: "current-slug.example.test", route },
      ],
    });
  });

  it("discovers only exact legacy security descriptions without writing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        result: {
          id: "ruleset-id",
          rules: [
            { id: "legacy-rule", description: "WAF defaults for example.test" },
            { id: "unsafe-near-match", description: "WAF defaults for example.test.old" },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const discovered = await cloudflare.discoverCloudflareSecurityResources({
      hostname: "example.test",
      cfHostnameId: "hostname-id",
      config: {},
    });
    expect(discovered.state).toBe("complete");
    expect(discovered.resources).toEqual([
      expect.objectContaining({
        kind: "ruleset_rule",
        id: "legacy-rule",
        rulesetId: "ruleset-id",
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
  });
});
