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
  delete process.env.CF_R2_ACCESS_KEY_ID;
  delete process.env.CF_R2_SECRET_ACCESS_KEY;
  delete process.env.CF_R2_BUCKET;
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

  const r2ListXml = (input: { keys: string[]; truncated?: boolean; nextToken?: string }): string =>
    `<ListBucketResult><KeyCount>${input.keys.length}</KeyCount><IsTruncated>${String(
      input.truncated ?? false,
    )}</IsTruncated>${input.keys
      .map((key) => `<Contents><Key>${key}</Key></Contents>`)
      .join(
        "",
      )}${input.nextToken ? `<NextContinuationToken>${input.nextToken}</NextContinuationToken>` : ""}</ListBucketResult>`;

  const enableR2 = (): void => {
    process.env.CF_R2_ACCESS_KEY_ID = "test-r2-key";
    process.env.CF_R2_SECRET_ACCESS_KEY = "test-r2-secret";
  };

  it("proves an empty strict custom-hostname target set without provider access", async () => {
    delete process.env.CF_API_TOKEN;
    delete process.env.CF_ZONE_ID;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloudflare.inventoryCustomHostnamesByHostname([])).resolves.toEqual({
      state: "complete",
      matches: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("paginates strict custom-hostname inventory and returns exact sanitized matches", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `id-${index}`,
      hostname: index === 9 ? "FIRST.example.test." : `unrelated-${index}.example.test`,
      ignored: "provider-detail",
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: firstPage,
          result_info: { count: 100, page: 1, per_page: 100, total_count: 101 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: [{ id: "second-id", hostname: "second.example.test", raw: "not-returned" }],
          result_info: { count: 1, page: 2, per_page: 100, total_count: 101 },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cloudflare.inventoryCustomHostnamesByHostname(["first.example.test", "SECOND.example.test."]),
    ).resolves.toEqual({
      state: "complete",
      matches: [
        { id: "id-9", hostname: "first.example.test" },
        { id: "second-id", hostname: "second.example.test" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "non-OK response",
      response: () => Promise.resolve(new Response(null, { status: 503 })),
      stage: "read",
    },
    {
      name: "malformed page",
      response: () =>
        Promise.resolve(
          Response.json({ success: true, result: [], result_info: { total_count: 0 } }),
        ),
      stage: "parse",
    },
    {
      name: "transport failure",
      response: () => Promise.reject(new Error("ambiguous transport")),
      stage: "read",
    },
  ])("fails strict custom-hostname inventory closed on $name", async ({ response, stage }) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(response));

    await expect(cloudflare.inventoryCustomHostnamesByHostname(["example.test"])).resolves.toEqual({
      state: "unavailable",
      stage,
    });
  });

  it("caps strict custom-hostname inventory before an incomplete provider walk", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        result: [],
        result_info: { count: 0, page: 1, per_page: 100, total_count: 2_001 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloudflare.inventoryCustomHostnamesByHostname(["example.test"])).resolves.toEqual({
      state: "unavailable",
      stage: "cap",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies wholly absent and partial R2 retirement configuration distinctly", async () => {
    delete process.env.CF_ACCOUNT_ID;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloudflare.retireLegacyR2ProjectPrefix(51)).resolves.toEqual({
      state: "not_configured",
      discoveredCount: 0,
      deletedCount: 0,
    });

    process.env.CF_ACCOUNT_ID = "test-account";
    await expect(cloudflare.retireLegacyR2ProjectPrefix(51)).resolves.toEqual({
      state: "unavailable",
      stage: "config",
      discoveredCount: 0,
      deletedCount: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proves an empty legacy R2 prefix absent with a second strict read", async () => {
    enableR2();
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(r2ListXml({ keys: [] }), {
          status: 200,
          headers: { "content-type": "application/xml" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloudflare.retireLegacyR2ProjectPrefix(51)).resolves.toEqual({
      state: "absent",
      discoveredCount: 0,
      deletedCount: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("paginates, deletes in a bounded request, and re-lists a legacy R2 prefix", async () => {
    enableR2();
    const firstPageKeys = Array.from({ length: 1_000 }, (_, index) =>
      index === 7 ? "51/seven &amp; safe.txt" : `51/item-${index}.txt`,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          r2ListXml({
            keys: firstPageKeys,
            truncated: true,
            nextToken: "next-token",
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(r2ListXml({ keys: ["51/final.txt"] })))
      .mockResolvedValueOnce(new Response("<DeleteResult></DeleteResult>"))
      .mockResolvedValueOnce(new Response("<DeleteResult></DeleteResult>"))
      .mockResolvedValueOnce(new Response(r2ListXml({ keys: [] })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await cloudflare.retireLegacyR2ProjectPrefix(51);
    expect(result).toEqual({ state: "absent", discoveredCount: 1_001, deletedCount: 1_001 });
    expect(JSON.stringify(result)).not.toContain("final.txt");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("continuation-token=next-token");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("delete=");
    const deleteCalls = fetchMock.mock.calls.slice(2, 4);
    expect(deleteCalls).toHaveLength(2);
    for (const call of deleteCalls) {
      const deleteInit = call[1] as RequestInit;
      expect(deleteInit.method).toBe("POST");
      expect(Buffer.isBuffer(deleteInit.body)).toBe(true);
      expect(String(deleteInit.body).match(/<Object>/g)?.length ?? 0).toBeLessThanOrEqual(1_000);
    }
  });

  it("does not call an ambiguous R2 delete successful", async () => {
    enableR2();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(r2ListXml({ keys: ["51/object.txt"] })))
      .mockRejectedValueOnce(new Error("ambiguous delete"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloudflare.retireLegacyR2ProjectPrefix(51)).resolves.toEqual({
      state: "unavailable",
      stage: "delete",
      discoveredCount: 1,
      deletedCount: 0,
    });
  });

  it.each([
    {
      name: "non-OK list response",
      response: () => new Response(null, { status: 502 }),
    },
    {
      name: "malformed list body",
      response: () =>
        new Response(
          "<ListBucketResult><KeyCount>1</KeyCount><IsTruncated>false</IsTruncated><Contents><Key>51/file<Unexpected/></Key></Contents></ListBucketResult>",
        ),
    },
  ])("fails a legacy R2 inventory closed on $name", async ({ response }) => {
    enableR2();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => response()),
    );

    await expect(cloudflare.retireLegacyR2ProjectPrefix(51)).resolves.toEqual({
      state: "unavailable",
      stage: "list",
      discoveredCount: 0,
      deletedCount: 0,
    });
  });

  it("does not call a per-object R2 delete error successful", async () => {
    enableR2();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(r2ListXml({ keys: ["51/object.txt"] })))
      .mockResolvedValueOnce(
        new Response(
          "<DeleteResult><Error><Key>51/object.txt</Key><Code>InternalError</Code></Error></DeleteResult>",
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloudflare.retireLegacyR2ProjectPrefix(51)).resolves.toEqual({
      state: "unavailable",
      stage: "delete",
      discoveredCount: 1,
      deletedCount: 0,
    });
  });

  it("does not call an ambiguous R2 verification absent", async () => {
    enableR2();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(r2ListXml({ keys: ["51/object.txt"] })))
      .mockResolvedValueOnce(new Response("<DeleteResult></DeleteResult>"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloudflare.retireLegacyR2ProjectPrefix(51)).resolves.toEqual({
      state: "unavailable",
      stage: "verify",
      discoveredCount: 1,
      deletedCount: 1,
    });
  });

  it("stops a legacy R2 prefix inventory at the object cap without deleting", async () => {
    enableR2();
    let page = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      page++;
      const pageKeys = Array.from({ length: 1_000 }, (_, index) => `51/item-${page}-${index}.txt`);
      return new Response(
        r2ListXml({ keys: pageKeys, truncated: true, nextToken: `token-${page}` }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloudflare.retireLegacyR2ProjectPrefix(51)).resolves.toEqual({
      state: "unavailable",
      stage: "cap",
      discoveredCount: 10_000,
      deletedCount: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(fetchMock.mock.calls.every((call) => (call[1] as RequestInit).method === "GET")).toBe(
      true,
    );
  });

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

  it("fails cache purge closed when the provider denies the purge permission", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        {
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
        },
        { status: 403 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloudflare.purgeCacheForHostnames(["published.example.test"])).resolves.toBe(
      false,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails cache purge closed when an HTTP success does not carry provider success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ success: false, result: null }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloudflare.purgeCacheForHostnames(["published.example.test"])).resolves.toBe(
      false,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
