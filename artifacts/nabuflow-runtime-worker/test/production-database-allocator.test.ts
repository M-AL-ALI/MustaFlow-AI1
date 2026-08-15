import { describe, expect, it } from "vitest";
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
