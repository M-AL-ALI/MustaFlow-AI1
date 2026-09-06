import { describe, expect, it, vi } from "vitest";
import {
  ProductionDatabaseAllocator,
  type ProductionDatabaseProviderFetch,
} from "../src/production-database-allocator";
import { fakeEnv } from "./helpers";

const identity = "a".repeat(64);
const providerProjectId = "quiet-tree-12345678";

function productionEnv() {
  return Object.assign(fakeEnv(), {
    CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "production",
    NABUFLOW_PRODUCTION_DATABASE_ALLOCATION_ENABLED: "enabled",
    NABUFLOW_PRODUCTION_NEON_MANAGEMENT_KEY: "test-management-material-with-sufficient-length",
    NABUFLOW_PRODUCTION_NEON_ORGANIZATION_ID: "org-production",
    NABUFLOW_PRODUCTION_NEON_REGION_ID: "aws-us-east-2",
    NABUFLOW_PRODUCTION_NEON_HISTORY_RETENTION_SECONDS: "604800",
    NABUFLOW_PRODUCTION_DATABASE_MAX_PROJECTS: "20",
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("production database allocator", () => {
  it("does not repair retention after authority expires during the retention GET", async () => {
    let authorityLost = false;
    let releaseRead!: () => void;
    let startedRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      startedRead = resolve;
    });
    const requests: string[] = [];
    const adapter: ProductionDatabaseProviderFetch = {
      async fetch(request) {
        const url = new URL(request.url);
        requests.push(request.method + " " + url.pathname);
        if (request.method === "GET" && url.pathname === "/api/v2/projects") {
          return json({
            projects: [
              {
                id: providerProjectId,
                name: `nabuflow-production-${identity.slice(0, 24)}`,
                region_id: "aws-us-east-2",
              },
            ],
          });
        }
        if (request.method === "GET" && url.pathname === `/api/v2/projects/${providerProjectId}`) {
          startedRead();
          await readGate;
          return json({ project: { history_retention_seconds: 0 } });
        }
        throw new Error("unexpected provider operation after retention authority loss");
      },
    };
    const pending = new ProductionDatabaseAllocator(productionEnv(), adapter).ensure({
      projectId: 42,
      allocationIdentity: identity,
      assertAuthority: async () => {
        if (authorityLost) throw new Error("production_database_authority_lost");
      },
    });
    const rejected = expect(pending).rejects.toThrow("production_database_authority_lost");
    await readStarted;
    authorityLost = true;
    releaseRead();
    await rejected;
    expect(requests).toEqual(["GET /api/v2/projects", `GET /api/v2/projects/${providerProjectId}`]);
  });

  it.each(["GET", "PATCH"] as const)(
    "rechecks authority after retention %s retry backoff before another attempt",
    async (failingMethod) => {
      vi.useFakeTimers();
      try {
        let authorityLost = false;
        let failedAttempt!: () => void;
        const attempted = new Promise<void>((resolve) => {
          failedAttempt = resolve;
        });
        const requests: string[] = [];
        const adapter: ProductionDatabaseProviderFetch = {
          async fetch(request) {
            const url = new URL(request.url);
            requests.push(request.method + " " + url.pathname);
            if (request.method === "GET" && url.pathname === "/api/v2/projects") {
              return json({
                projects: [
                  {
                    id: providerProjectId,
                    name: `nabuflow-production-${identity.slice(0, 24)}`,
                    region_id: "aws-us-east-2",
                  },
                ],
              });
            }
            if (url.pathname === `/api/v2/projects/${providerProjectId}`) {
              if (request.method === failingMethod) {
                failedAttempt();
                return new Response(null, { status: 503 });
              }
              if (request.method === "GET") {
                return json({ project: { history_retention_seconds: 0 } });
              }
            }
            throw new Error("unexpected provider operation after retry authority loss");
          },
        };
        const pending = new ProductionDatabaseAllocator(productionEnv(), adapter).ensure({
          projectId: 42,
          allocationIdentity: identity,
          assertAuthority: async () => {
            if (authorityLost) throw new Error("production_database_authority_lost");
          },
        });
        const rejected = expect(pending).rejects.toThrow("production_database_authority_lost");
        await attempted;
        // Flush the failed response so exactOperation is waiting in retry backoff.
        await vi.advanceTimersByTimeAsync(0);
        authorityLost = true;
        await vi.advanceTimersByTimeAsync(100);
        await rejected;
        expect(
          requests.filter(
            (request) => request === failingMethod + " /api/v2/projects/" + providerProjectId,
          ),
        ).toHaveLength(1);
        expect(requests.some((request) => request.startsWith("POST "))).toBe(false);
        expect(requests.some((request) => request.includes("connection_uri"))).toBe(false);
        if (failingMethod === "GET")
          expect(requests.some((request) => request.startsWith("PATCH "))).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  const releaseScope = {
    providerOrganizationId: "org-production",
    regionId: "aws-us-east-2",
    historyRetentionSeconds: 604_800,
  };
  const releaseProject = {
    id: providerProjectId,
    name: `nabuflow-production-${identity.slice(0, 24)}`,
    org_id: "org-production",
    region_id: "aws-us-east-2",
    history_retention_seconds: 604_800,
  };

  it("resolves release ownership with complete paginated GETs only, without cost admission or credential reads", async () => {
    const calls: string[] = [];
    const env = productionEnv();
    env.NABUFLOW_PRODUCTION_DATABASE_MAX_PROJECTS = "1";
    const adapter: ProductionDatabaseProviderFetch = {
      async fetch(request) {
        const url = new URL(request.url);
        calls.push(request.method + " " + url.pathname);
        expect(request.method).toBe("GET");
        expect(url.pathname).not.toContain("connection_uri");
        if (url.pathname === "/api/v2/projects") {
          return url.searchParams.has("cursor")
            ? json({ projects: [releaseProject] })
            : json({
                projects: [{ id: "other", name: "nabuflow-production-other" }],
                pagination: { cursor: "opaque /+=" },
              });
        }
        return json({ project: releaseProject });
      },
    };
    const result = await new ProductionDatabaseAllocator(env, adapter).resolveForRelease({
      projectId: 42,
      allocationIdentity: identity,
      scope: releaseScope,
      assertAuthority: async () => undefined,
    });
    expect(result).toMatchObject({ state: "releasing", providerProjectId });
    expect(result).not.toHaveProperty("connectionString");
    expect(calls).toEqual([
      "GET /api/v2/projects",
      "GET /api/v2/projects",
      `GET /api/v2/projects/${providerProjectId}`,
    ]);
  });

  it.each([
    { projects: [], unavailable: ["missing"] },
    { projects: [], unavailable_project_ids: ["missing"] },
    { projects: [releaseProject, { ...releaseProject, id: "duplicate-owner" }] },
    { projects: Array.from({ length: 50 }, (_, index) => ({ id: `id-${index}`, name: "other" })) },
  ])("never resolves an ambiguous or partial release inventory %#", async (body) => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe("GET");
      return json(body);
    });
    await expect(
      new ProductionDatabaseAllocator(productionEnv(), { fetch }).resolveForRelease({
        projectId: 42,
        allocationIdentity: identity,
        scope: releaseScope,
        assertAuthority: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "production_database_integrity_failure" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not use an early exact match when a later catalog page is partial", async () => {
    let calls = 0;
    const adapter: ProductionDatabaseProviderFetch = {
      async fetch(request) {
        expect(request.method).toBe("GET");
        calls += 1;
        return calls === 1
          ? json({ projects: [releaseProject], pagination: { cursor: "next" } })
          : json({ projects: [], unavailable: ["missing"] });
      },
    };
    await expect(
      new ProductionDatabaseAllocator(productionEnv(), adapter).resolveForRelease({
        projectId: 42,
        allocationIdentity: identity,
        scope: releaseScope,
        assertAuthority: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "production_database_integrity_failure" });
    expect(calls).toBe(2);
  });

  it.each(["org_id", "region_id", "name", "id", "history_retention_seconds"])(
    "rejects mismatched recovered provider %s without mutation",
    async (field) => {
      const adapter: ProductionDatabaseProviderFetch = {
        async fetch(request) {
          expect(request.method).toBe("GET");
          return new URL(request.url).pathname === "/api/v2/projects"
            ? json({ projects: [releaseProject] })
            : json({ project: { ...releaseProject, [field]: "wrong" } });
        },
      };
      await expect(
        new ProductionDatabaseAllocator(productionEnv(), adapter).resolveForRelease({
          projectId: 42,
          allocationIdentity: identity,
          scope: releaseScope,
          assertAuthority: async () => undefined,
        }),
      ).rejects.toMatchObject({ code: "production_database_scope_mismatch" });
    },
  );

  it("leaves zero matches unresolved and rejects unproven historical scope before provider calls", async () => {
    const fetch = vi.fn(async () => json({ projects: [] }));
    const allocator = new ProductionDatabaseAllocator(productionEnv(), { fetch });
    await expect(
      allocator.resolveForRelease({
        projectId: 42,
        allocationIdentity: identity,
        scope: releaseScope,
        assertAuthority: async () => undefined,
      }),
    ).resolves.toBeNull();
    await expect(
      allocator.resolveForRelease({
        projectId: 42,
        allocationIdentity: identity,
        scope: { ...releaseScope, providerOrganizationId: "org-other" },
        assertAuthority: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "production_database_scope_mismatch" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("produces a versioned legacy absence proof only from a complete paginated catalog", async () => {
    let calls = 0;
    const authority = vi.fn(async () => undefined);
    const allocator = new ProductionDatabaseAllocator(
      productionEnv(),
      {
        async fetch(request) {
          expect(request.method).toBe("GET");
          calls += 1;
          return calls === 1
            ? json({
                projects: [{ id: "owned-other", name: "nabuflow-production-other" }],
                pagination: { cursor: "next" },
              })
            : json({ projects: [{ id: "customer-project", name: "customer-project" }] });
        },
      },
      () => new Date("2026-08-15T12:06:00.000Z"),
    );
    await expect(
      allocator.resolveLegacyForRelease({
        projectId: 42,
        allocationIdentity: identity,
        assertAuthority: authority,
      }),
    ).resolves.toMatchObject({
      state: "absent",
      proof: {
        providerOrganizationId: "org-production",
        expectedProjectName: `nabuflow-production-${identity.slice(0, 24)}`,
        catalogProjectCount: 2,
        catalogOwnedProjectCount: 1,
        catalogPageCount: 2,
        verifiedAt: "2026-08-15T12:06:00.000Z",
      },
    });
    const result = await allocator.resolveLegacyForRelease({
      projectId: 42,
      allocationIdentity: identity,
      assertAuthority: authority,
    });
    if (result.state !== "absent") throw new Error("expected catalog absence");
    expect(result.proof.catalogDigestSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("stops discovery before a second page when execution authority expires", async () => {
    let lost = false;
    const fetch = vi.fn(async () => {
      lost = true;
      return json({ projects: [], pagination: { cursor: "next" } });
    });
    await expect(
      new ProductionDatabaseAllocator(productionEnv(), { fetch }).resolveForRelease({
        projectId: 42,
        allocationIdentity: identity,
        scope: releaseScope,
        assertAuthority: async () => {
          if (lost) throw new Error("production_database_authority_lost");
        },
      }),
    ).rejects.toThrow("production_database_authority_lost");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not repeat a create when the durable dispatch claim is already held", async () => {
    let claimed = false;
    let creates = 0;
    const adapter: ProductionDatabaseProviderFetch = {
      async fetch(request) {
        if (request.method === "POST") {
          creates += 1;
          throw new TypeError("uncertain provider completion");
        }
        return json({ projects: [] });
      },
    };
    const beforeCreate = async () => {
      if (claimed) throw new Error("allocation_dispatch_unresolved");
      claimed = true;
    };
    const allocator = new ProductionDatabaseAllocator(productionEnv(), adapter);
    await expect(
      allocator.ensure({ projectId: 42, allocationIdentity: identity, beforeCreate }),
    ).rejects.toThrow("allocation_dispatch_unresolved");
    await expect(
      allocator.ensure({ projectId: 42, allocationIdentity: identity, beforeCreate }),
    ).rejects.toThrow("allocation_dispatch_unresolved");
    expect(creates).toBe(1);
  });

  it("records provider ownership before a later retention lookup can fail", async () => {
    const events: string[] = [];
    const adapter: ProductionDatabaseProviderFetch = {
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/v2/projects" && request.method === "GET") {
          return json({ projects: [] });
        }
        if (request.method === "POST") {
          events.push("post");
          return json({ project: { id: providerProjectId } }, 201);
        }
        events.push("retention-read");
        return json({}, 403);
      },
    };
    await expect(
      new ProductionDatabaseAllocator(productionEnv(), adapter).ensure({
        projectId: 42,
        allocationIdentity: identity,
        beforeCreate: async (scope) => {
          expect(scope.providerOrganizationId).toBe("org-production");
          events.push("intent");
        },
        onProjectResolved: async (project) => {
          expect(project.providerProjectId).toBe(providerProjectId);
          events.push("ownership");
        },
      }),
    ).rejects.toMatchObject({ causeClass: "provider_rejected" });
    expect(events).toEqual(["intent", "post", "ownership", "retention-read"]);
  });

  it("finds an existing allocation on a later page and preserves opaque cursors", async () => {
    const cursors: Array<string | null> = [];
    let creates = 0;
    const adapter: ProductionDatabaseProviderFetch = {
      async fetch(request) {
        const url = new URL(request.url);
        expect(request.redirect).toBe("error");
        if (request.method === "POST") {
          creates += 1;
          throw new Error("must reuse, not create");
        }
        if (url.pathname === "/api/v2/projects") {
          expect(url.searchParams.get("limit")).toBe("50");
          const cursor = url.searchParams.get("cursor");
          cursors.push(cursor);
          return cursor === null
            ? json({
                projects: [{ id: "unrelated", name: "other-project" }],
                pagination: { cursor: "opaque /+= cursor" },
                unavailable_project_ids: [],
              })
            : json({
                projects: [
                  { id: providerProjectId, name: `nabuflow-production-${identity.slice(0, 24)}` },
                ],
                unavailable: [],
                applications: [],
              });
        }
        if (url.pathname.endsWith("/connection_uri")) {
          return json({
            uri: "postgresql://runtime:transient@ep-test.us-east-2.aws.neon.tech/neondb",
          });
        }
        return json({ project: { history_retention_seconds: 604_800 } });
      },
    };
    const env = productionEnv();
    env.NABUFLOW_PRODUCTION_DATABASE_MAX_PROJECTS = "10000";
    const result = await new ProductionDatabaseAllocator(env, adapter).ensure({
      projectId: 42,
      allocationIdentity: identity,
    });
    expect(result.reused).toBe(true);
    expect(cursors).toEqual([null, "opaque /+= cursor"]);
    expect(creates).toBe(0);
  });

  it.each([
    {},
    { projects: null },
    { projects: [], unavailable: ["missing"] },
    { projects: [], unavailable_project_ids: ["missing"] },
    { projects: [], unavailable: null },
    { projects: [], unavailable_project_ids: "missing" },
    { projects: [], pagination: null },
    { projects: [], pagination: {} },
    { projects: [], pagination: { cursor: "" } },
    { projects: [{ id: "missing-name" }] },
  ])("never creates from malformed or partial inventory %#", async (body) => {
    const methods: string[] = [];
    const adapter: ProductionDatabaseProviderFetch = {
      async fetch(request) {
        methods.push(request.method);
        return json(body);
      },
    };
    await expect(
      new ProductionDatabaseAllocator(productionEnv(), adapter).ensure({
        projectId: 42,
        allocationIdentity: identity,
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(methods).toEqual(["GET"]);
  });

  it.each(["cursor-loop", "duplicate-id", "page-budget"])(
    "rejects incomplete traversal: %s",
    async (failure) => {
      let calls = 0;
      const adapter: ProductionDatabaseProviderFetch = {
        async fetch(request) {
          expect(request.method).toBe("GET");
          calls += 1;
          return json({
            projects: failure === "duplicate-id" ? [{ id: "duplicate", name: "unrelated" }] : [],
            pagination: { cursor: failure === "cursor-loop" ? "same" : `page-${calls}` },
          });
        },
      };
      await expect(
        new ProductionDatabaseAllocator(productionEnv(), adapter).ensure({
          projectId: 42,
          allocationIdentity: identity,
        }),
      ).rejects.toMatchObject({ code: "production_database_integrity_failure", retryable: false });
      expect(calls).toBe(failure === "page-budget" ? 256 : 2);
    },
  );

  it("cancels an oversized streamed provider response before accumulating it", async () => {
    let cancelled = false;
    const adapter: ProductionDatabaseProviderFetch = {
      async fetch(request) {
        expect(request.method).toBe("GET");
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(64 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    };
    await expect(
      new ProductionDatabaseAllocator(productionEnv(), adapter).ensure({
        projectId: 42,
        allocationIdentity: identity,
      }),
    ).rejects.toMatchObject({ causeClass: "malformed_response" });
    expect(cancelled).toBe(true);
  });

  it("fails inert before provider dispatch when a production guard is absent", async () => {
    let calls = 0;
    const adapter: ProductionDatabaseProviderFetch = {
      async fetch() {
        calls += 1;
        return json({});
      },
    };
    await expect(
      new ProductionDatabaseAllocator(fakeEnv(), adapter).ensure({
        projectId: 42,
        allocationIdentity: identity,
      }),
    ).rejects.toMatchObject({ code: "production_database_inert", causeClass: "pre_dispatch" });
    expect(calls).toBe(0);
  });

  it("creates a region-pinned project, verifies retention, and returns the credential only in memory", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const adapter: ProductionDatabaseProviderFetch = {
      async fetch(request) {
        const url = new URL(request.url);
        const body = request.method === "POST" ? await request.clone().json() : null;
        calls.push({ method: request.method, path: `${url.pathname}${url.search}`, body });
        if (request.method === "GET" && url.pathname === "/api/v2/projects") {
          return json({ projects: [] });
        }
        if (request.method === "POST" && url.pathname === "/api/v2/projects") {
          return json({ project: { id: providerProjectId } }, 201);
        }
        if (request.method === "GET" && url.pathname === `/api/v2/projects/${providerProjectId}`) {
          return json({ project: { id: providerProjectId, history_retention_seconds: 604_800 } });
        }
        if (url.pathname.endsWith("/connection_uri")) {
          return json({
            uri: "postgresql://runtime:transient@ep-test.us-east-2.aws.neon.tech/neondb",
          });
        }
        throw new Error(`unexpected ${request.method} ${url.pathname}`);
      },
    };
    const material = await new ProductionDatabaseAllocator(
      productionEnv(),
      adapter,
      () => new Date("2026-08-15T12:00:00.000Z"),
    ).ensure({ projectId: 42, allocationIdentity: identity });

    expect(material).toMatchObject({
      reused: false,
      allocation: {
        projectId: 42,
        providerProjectId,
        providerOrganizationId: "org-production",
        regionId: "aws-us-east-2",
        historyRetentionSeconds: 604_800,
      },
    });
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      project: {
        name: `nabuflow-production-${identity.slice(0, 24)}`,
        region_id: "aws-us-east-2",
        history_retention_seconds: 604_800,
      },
    });
    expect(JSON.stringify(material.allocation)).not.toContain(material.connectionString);
  });

  it("warm-reuses the exact provider object without a create and repairs retention by exact set", async () => {
    let retention = 86_400;
    let creates = 0;
    let patches = 0;
    const adapter: ProductionDatabaseProviderFetch = {
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/api/v2/projects") {
          return json({
            projects: [
              {
                id: providerProjectId,
                name: `nabuflow-production-${identity.slice(0, 24)}`,
                region_id: "aws-us-east-2",
              },
            ],
          });
        }
        if (request.method === "POST") {
          creates += 1;
          return json({}, 500);
        }
        if (request.method === "PATCH") {
          patches += 1;
          const body = (await request.json()) as {
            project: { history_retention_seconds: number };
          };
          retention = body.project.history_retention_seconds;
          return json({ project: { history_retention_seconds: retention } });
        }
        if (request.method === "GET" && url.pathname === `/api/v2/projects/${providerProjectId}`) {
          return json({ project: { history_retention_seconds: retention } });
        }
        if (url.pathname.endsWith("/connection_uri")) {
          return json({
            uri: "postgresql://runtime:transient@ep-test.us-east-2.aws.neon.tech/neondb",
          });
        }
        throw new Error(`unexpected ${request.method} ${url.pathname}`);
      },
    };
    const material = await new ProductionDatabaseAllocator(productionEnv(), adapter).ensure({
      projectId: 42,
      allocationIdentity: identity,
    });
    expect(material.reused).toBe(true);
    expect(creates).toBe(0);
    expect(patches).toBe(1);
    expect(retention).toBe(604_800);
  });

  it("discovers an ambiguous create winner before retrying the body-bearing operation", async () => {
    let listCalls = 0;
    let createCalls = 0;
    const adapter: ProductionDatabaseProviderFetch = {
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/api/v2/projects") {
          listCalls += 1;
          return json({
            projects:
              listCalls === 1
                ? []
                : [
                    {
                      id: providerProjectId,
                      name: `nabuflow-production-${identity.slice(0, 24)}`,
                      region_id: "aws-us-east-2",
                    },
                  ],
          });
        }
        if (request.method === "POST") {
          createCalls += 1;
          throw new TypeError("connection reset after dispatch");
        }
        if (request.method === "GET" && url.pathname === `/api/v2/projects/${providerProjectId}`) {
          return json({ project: { history_retention_seconds: 604_800 } });
        }
        if (url.pathname.endsWith("/connection_uri")) {
          return json({
            uri: "postgresql://runtime:transient@ep-test.us-east-2.aws.neon.tech/neondb",
          });
        }
        throw new Error(`unexpected ${request.method} ${url.pathname}`);
      },
    };
    const material = await new ProductionDatabaseAllocator(productionEnv(), adapter).ensure({
      projectId: 42,
      allocationIdentity: identity,
    });
    expect(material.allocation.providerProjectId).toBe(providerProjectId);
    expect(createCalls).toBe(1);
    expect(listCalls).toBe(2);
  });

  it("fails closed on cost, ownership, and credential integrity violations", async () => {
    const atLimit = productionEnv();
    atLimit.NABUFLOW_PRODUCTION_DATABASE_MAX_PROJECTS = "1";
    const costAdapter: ProductionDatabaseProviderFetch = {
      async fetch() {
        return json({ projects: [{ id: "other", name: "nabuflow-production-other" }] });
      },
    };
    await expect(
      new ProductionDatabaseAllocator(atLimit, costAdapter).ensure({
        projectId: 42,
        allocationIdentity: identity,
      }),
    ).rejects.toMatchObject({ code: "production_database_cost_limit" });

    const allocation = {
      format: "nabuflow.production-database-allocation/v1" as const,
      projectId: 42,
      allocationIdentity: identity,
      provider: "neon-postgres" as const,
      providerProjectId,
      providerOrganizationId: "org-other",
      regionId: "aws-us-east-2",
      historyRetentionSeconds: 604_800,
      revision: "production-database-a",
      state: "ready" as const,
      createdAt: "2026-08-15T12:00:00.000Z",
      updatedAt: "2026-08-15T12:00:00.000Z",
    };
    await expect(
      new ProductionDatabaseAllocator(productionEnv(), costAdapter).release(allocation),
    ).rejects.toMatchObject({ code: "production_database_scope_mismatch" });
  });

  it("retries typed provider weather and verifies deletion authoritatively", async () => {
    let calls = 0;
    const adapter: ProductionDatabaseProviderFetch = {
      async fetch(request) {
        calls += 1;
        if (calls === 1) return json({}, 503);
        return request.method === "DELETE" ? new Response(null, { status: 204 }) : json({}, 404);
      },
    };
    const allocation = {
      format: "nabuflow.production-database-allocation/v1" as const,
      projectId: 42,
      allocationIdentity: identity,
      provider: "neon-postgres" as const,
      providerProjectId,
      providerOrganizationId: "org-production",
      regionId: "aws-us-east-2",
      historyRetentionSeconds: 604_800,
      revision: "production-database-a",
      state: "releasing" as const,
      createdAt: "2026-08-15T12:00:00.000Z",
      updatedAt: "2026-08-15T12:00:00.000Z",
    };
    const allocator = new ProductionDatabaseAllocator(productionEnv(), adapter);
    await allocator.release(allocation);
    await expect(allocator.verifyGone(allocation)).resolves.toBe(true);
    expect(calls).toBe(3);
  });
});
