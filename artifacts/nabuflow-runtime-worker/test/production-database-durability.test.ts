import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeContracts from "@workspace/tenant-runtime-contracts";
import {
  productionDatabaseAllocationIdentity,
  type ProductionDatabaseAllocationRecord,
} from "@workspace/tenant-runtime-contracts";
import { CapabilityVaultDurableObject } from "../src/capability-vault-durable-object";
import {
  ProductionDatabaseProviderError,
  ProductionDatabaseAllocator,
  type ProductionDatabaseProviderFetch,
  type ProductionDatabaseMaterial,
  type ProductionDatabaseReleaseResolutionInput,
} from "../src/production-database-allocator";
import type { ProductionDatabaseEnsureInput } from "../src/production-database-intent";
import { handleControlRequest } from "../src/worker";
import {
  MemoryCoordinator,
  MockBackend,
  TEST_NOW_MS,
  drainArtifactCommitQueue,
  fakeEnv,
  mutationAndDrain,
  productionDatabaseAdmissionFixture,
  signedRequest,
} from "./helpers";

const path = "/_nabuflow/control/v1/capabilities/42/neon-postgres/database/production-allocation";
const scope = {
  providerOrganizationId: "org-production",
  regionId: "aws-us-east-2",
  historyRetentionSeconds: 604_800,
};
const checkpoints = [
  "initialized",
  "ownership-verified",
  "provider-complete",
  "provider-verified",
  "vault-complete",
  "finalized",
] as const;

// Exercise the actual vault implementation, including transaction rollback and restart.
class IntentStorage {
  values = new Map<string, unknown>();
  failNextCommit = false;
  private tail: Promise<unknown> = Promise.resolve();

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
  transaction<T>(work: (transaction: IntentStorage) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const previous = structuredClone(this.values);
      try {
        const value = await work(this);
        if (this.failNextCommit) {
          this.failNextCommit = false;
          throw new Error("synthetic storage commit failure");
        }
        return value;
      } catch (error) {
        this.values = previous;
        throw error;
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}

async function fixture() {
  const env = Object.assign(fakeEnv(), {
    NABUFLOW_PRODUCTION_DATABASE_ALLOCATION_ENABLED: "enabled",
    NABUFLOW_STAGING_PRODUCTION_DATABASE_REHEARSAL: "enabled",
  });
  const storage = new IntentStorage();
  const state = { storage } as unknown as DurableObjectState;
  const vault = new CapabilityVaultDurableObject(state, env);
  const coordinator = new MemoryCoordinator();
  const backend = new MockBackend();
  const owner = {
    projectId: 42,
    allocationIdentity: await productionDatabaseAllocationIdentity({
      format: "nabuflow.production-database-allocation/v1",
      deploymentNamespace: "production",
      projectId: 42,
    }),
  };
  const material: ProductionDatabaseMaterial = {
    allocation: {
      format: "nabuflow.production-database-allocation/v1",
      ...owner,
      ...scope,
      provider: "neon-postgres",
      providerProjectId: "owned-production-project",
      revision: "production-database-" + owner.allocationIdentity.slice(0, 48),
      state: "ready",
      createdAt: new Date(TEST_NOW_MS).toISOString(),
      updatedAt: new Date(TEST_NOW_MS).toISOString(),
    },
    connectionString: "postgresql://fixture:secret@ep-fixture.us-east-2.aws.neon.tech/neondb",
    reused: false,
  };
  const effects = { posts: 0 };
  const allocator = {
    resolveForRelease: vi.fn(
      async (
        _input: ProductionDatabaseReleaseResolutionInput,
      ): Promise<ProductionDatabaseAllocationRecord | null> => null,
    ),
    ensure: vi.fn(
      async (input: ProductionDatabaseEnsureInput): Promise<ProductionDatabaseMaterial> => {
        // This is also the integration guard: worker calls always carry both hooks.
        expect(input.beforeCreate).toBeTypeOf("function");
        expect(input.onProjectResolved).toBeTypeOf("function");
        await input.beforeCreate!(scope);
        expect(await vault.getProductionDatabaseIntent(owner)).toMatchObject({
          state: "dispatched",
        });
        effects.posts += 1;
        await input.onProjectResolved!({
          ...scope,
          providerProjectId: material.allocation.providerProjectId,
        });
        return structuredClone(material);
      },
    ),
    release: vi.fn(async (_allocation: ProductionDatabaseAllocationRecord): Promise<void> => {}),
    verifyGone: vi.fn(async (_allocation: ProductionDatabaseAllocationRecord) => true),
  };
  return { env, storage, state, vault, coordinator, backend, owner, material, effects, allocator };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function run(f: Fixture, action: "ensure" | "release", key: string) {
  return mutationAndDrain({
    path,
    method: action === "ensure" ? "PUT" : "DELETE",
    body: {
      ...f.owner,
      action,
      expectedDeploymentVersion: "worker-version-test-1",
      ...(action === "ensure"
        ? { admission: productionDatabaseAdmissionFixture(f.owner, "authorized") }
        : {}),
    },
    nonce: `production-database-durability-${key}`,
    idempotencyKey: key,
    env: f.env,
    coordinator: f.coordinator,
    backend: f.backend,
    vault: f.vault,
    productionDatabaseAllocator: f.allocator,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_NOW_MS);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("sealed production database durable intent", () => {
  function activeJob(f: Awaited<ReturnType<typeof fixture>>) {
    const job = [...f.coordinator.runtimeLifecycleJobs.values()].find(
      (candidate) => candidate.kind === "production-database" && candidate.state === "active",
    );
    if (job === undefined || job.leaseUntilMs === null) {
      throw new Error("expected a leased production database job");
    }
    return job;
  }

  function delayInitialIdentity(f: Awaited<ReturnType<typeof fixture>>) {
    const calculate = runtimeContracts.productionDatabaseAllocationIdentity;
    let delayed = false;
    vi.spyOn(runtimeContracts, "productionDatabaseAllocationIdentity").mockImplementation(
      async (input) => {
        const identity = await calculate(input);
        if (
          !delayed &&
          [...f.coordinator.runtimeLifecycleJobs.values()].some(
            (job) => job.kind === "production-database" && job.state === "active",
          )
        ) {
          delayed = true;
          vi.setSystemTime(Date.now() + 250);
        }
        return identity;
      },
    );
    return () => delayed;
  }

  function realAllocator(
    f: Awaited<ReturnType<typeof fixture>>,
    adapter: ProductionDatabaseProviderFetch,
  ) {
    Object.assign(f.env, {
      NABUFLOW_PRODUCTION_NEON_MANAGEMENT_KEY: "test-management-material-with-sufficient-length",
      NABUFLOW_PRODUCTION_NEON_ORGANIZATION_ID: scope.providerOrganizationId,
      NABUFLOW_PRODUCTION_NEON_REGION_ID: scope.regionId,
      NABUFLOW_PRODUCTION_NEON_HISTORY_RETENTION_SECONDS: String(scope.historyRetentionSeconds),
      NABUFLOW_PRODUCTION_DATABASE_MAX_PROJECTS: "20",
    });
    return new ProductionDatabaseAllocator(f.env, adapter);
  }

  function runRealAllocator(
    f: Awaited<ReturnType<typeof fixture>>,
    allocator: ProductionDatabaseAllocator,
    key: string,
  ) {
    return mutationAndDrain({
      path,
      method: "PUT",
      body: {
        ...f.owner,
        action: "ensure",
        expectedDeploymentVersion: "worker-version-test-1",
        admission: productionDatabaseAdmissionFixture(f.owner, "authorized"),
      },
      nonce: "production-database-clock-" + key,
      idempotencyKey: key,
      env: f.env,
      coordinator: f.coordinator,
      backend: f.backend,
      vault: f.vault,
      productionDatabaseAllocator: allocator,
    });
  }

  it.each(["lease", "deadline"] as const)(
    "includes initial identity latency when %s expires before a real allocator POST",
    async (boundary) => {
      const f = await fixture();
      const delayed = delayInitialIdentity(f);
      const requests: string[] = [];
      const allocator = realAllocator(f, {
        async fetch(request) {
          requests.push(request.method + " " + new URL(request.url).pathname);
          if (request.method === "GET") {
            return new Response(JSON.stringify({ projects: [] }), {
              headers: { "content-type": "application/json" },
            });
          }
          if (request.method === "POST") {
            return new Response(
              JSON.stringify({ project: { id: f.material.allocation.providerProjectId } }),
              {
                status: 201,
                headers: { "content-type": "application/json" },
              },
            );
          }
          throw new Error("unexpected provider operation");
        },
      });
      const readIntent = f.vault.getProductionDatabaseIntent.bind(f.vault);
      let crossed = false;
      vi.spyOn(f.vault, "getProductionDatabaseIntent").mockImplementation(async (input) => {
        const intent = await readIntent(input);
        if (!crossed && intent?.state === "dispatched") {
          crossed = true;
          const job = activeJob(f);
          const expiry = Math.min(job.leaseUntilMs!, job.deadlineMs);
          if (boundary === "deadline") {
            job.deadlineMs = expiry;
            job.leaseUntilMs = expiry + 10_000;
          }
          vi.setSystemTime(expiry + 1);
        }
        return intent;
      });
      const response = await runRealAllocator(f, allocator, "identity-before-post-" + boundary);
      expect(delayed()).toBe(true);
      expect(crossed).toBe(true);
      expect(response.status).toBe(409);
      expect(requests).toEqual(["GET /api/v2/projects"]);
      expect(await readIntent(f.owner)).toMatchObject({
        state: "dispatched",
        providerProjectId: null,
      });
      expect(await f.vault.getProductionDatabaseAllocation(f.owner)).toBeNull();
    },
  );

  it.each([true, false])(
    "uses the real worker clock for retention repair after delayed identity (expiry=%s)",
    async (expire) => {
      const f = await fixture();
      const delayed = delayInitialIdentity(f);
      const providerId = f.material.allocation.providerProjectId;
      const requests: string[] = [];
      let retention = 0;
      const allocator = realAllocator(f, {
        async fetch(request) {
          const url = new URL(request.url);
          requests.push(request.method + " " + url.pathname);
          if (request.method === "GET" && url.pathname === "/api/v2/projects") {
            return new Response(
              JSON.stringify({
                projects: [
                  {
                    id: providerId,
                    name: "nabuflow-production-" + f.owner.allocationIdentity.slice(0, 24),
                    region_id: scope.regionId,
                  },
                ],
              }),
              { headers: { "content-type": "application/json" } },
            );
          }
          if (request.method === "GET" && url.pathname === "/api/v2/projects/" + providerId) {
            if (expire) {
              const job = activeJob(f);
              vi.setSystemTime(Math.min(job.leaseUntilMs!, job.deadlineMs) + 1);
            }
            return new Response(
              JSON.stringify({ project: { history_retention_seconds: retention } }),
              {
                headers: { "content-type": "application/json" },
              },
            );
          }
          if (request.method === "PATCH" && url.pathname === "/api/v2/projects/" + providerId) {
            retention = scope.historyRetentionSeconds;
            return new Response(
              JSON.stringify({ project: { history_retention_seconds: retention } }),
              {
                headers: { "content-type": "application/json" },
              },
            );
          }
          if (request.method === "GET" && url.pathname.endsWith("/connection_uri")) {
            return new Response(JSON.stringify({ uri: f.material.connectionString }), {
              headers: { "content-type": "application/json" },
            });
          }
          throw new Error("unexpected provider operation");
        },
      });
      const response = await runRealAllocator(f, allocator, "identity-retention-" + String(expire));
      expect(delayed()).toBe(true);
      expect(response.status).toBe(expire ? 409 : 200);
      expect(requests.filter((request) => request.startsWith("PATCH "))).toHaveLength(
        expire ? 0 : 1,
      );
      expect(requests.some((request) => request.startsWith("POST "))).toBe(false);
      expect(requests.some((request) => request.includes("connection_uri"))).toBe(!expire);
      if (expire) {
        expect(await f.vault.getProductionDatabaseIntent(f.owner)).toMatchObject({
          state: "provider-known",
          providerProjectId: providerId,
        });
        expect(await f.vault.getProductionDatabaseAllocation(f.owner)).toBeNull();
      } else {
        expect(await f.vault.getProductionDatabaseAllocation(f.owner)).toMatchObject({
          state: "ready",
        });
      }
    },
  );

  it("retains ownership and refuses completion when provider absence verification is false", async () => {
    const f = await fixture();
    expect((await run(f, "ensure", "seed-before-negative-absence")).status).toBe(200);
    const complete = vi.spyOn(f.vault, "completeProductionDatabaseRelease");
    f.allocator.verifyGone.mockResolvedValue(false);
    const response = await run(f, "release", "negative-absence-retains-owner");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "production_database_cleanup_incomplete" });
    expect(complete).not.toHaveBeenCalled();
    expect(await f.vault.getProductionDatabaseAllocation(f.owner)).toMatchObject({
      state: "releasing",
    });
    const intent = await f.vault.getProductionDatabaseIntent(f.owner);
    expect(intent).toMatchObject({
      state: "releasing",
      providerProjectId: f.material.allocation.providerProjectId,
    });
    expect(intent).not.toHaveProperty("completionEvidence");
  });

  it.each(["lease", "owner", "generation", "deadline"] as const)(
    "does not dispatch after the final intent RPC loses %s authority",
    async (change) => {
      const f = await fixture();
      const readIntent = f.vault.getProductionDatabaseIntent.bind(f.vault);
      vi.spyOn(f.vault, "getProductionDatabaseIntent").mockImplementation(async (input) => {
        const intent = await readIntent(input);
        if (intent?.state === "dispatched") {
          // The durable claim was acknowledged while authority was still valid.
          // Loss occurs during the final awaited intent read, before provider POST.
          if (change === "lease") vi.setSystemTime(TEST_NOW_MS + 15_000);
          else
            for (const job of f.coordinator.runtimeLifecycleJobs.values()) {
              if (job.kind === "production-database" && job.state === "active") {
                if (change === "owner") job.ownerId = "replacement-owner-after-intent-read";
                else if (change === "generation") job.attempt += 1;
                else job.deadlineMs = TEST_NOW_MS;
              }
            }
        }
        return intent;
      });
      expect((await run(f, "ensure", "delayed-intent-read-" + change)).status).toBe(409);
      expect(f.effects.posts).toBe(0);
      expect(await readIntent(f.owner)).toMatchObject({
        state: "dispatched",
        providerProjectId: null,
      });
      expect(await f.vault.getProductionDatabaseAllocation(f.owner)).toBeNull();
    },
  );

  it("awaits persistent dispatch and suppresses another POST after uncertainty, new jobs and vault restart", async () => {
    const f = await fixture();
    f.allocator.ensure.mockImplementation(async (input) => {
      expect(input.beforeCreate).toBeTypeOf("function");
      expect(input.onProjectResolved).toBeTypeOf("function");
      await input.beforeCreate!(scope);
      f.effects.posts += 1;
      throw new ProductionDatabaseProviderError(
        504,
        "production_database_provider_unavailable",
        true,
        "timeout",
      );
    });
    expect((await run(f, "ensure", "uncertain-first")).status).toBe(504);
    f.vault = new CapabilityVaultDurableObject(f.state, f.env);
    expect((await run(f, "ensure", "uncertain-new-job")).status).toBe(503);
    expect(f.effects.posts).toBe(1);
    expect(await f.vault.getProductionDatabaseIntent(f.owner)).toMatchObject({
      state: "dispatched",
    });
    const release = await run(f, "release", "uncertain-release");
    expect(release.status).toBe(503);
    expect(await release.json()).not.toMatchObject({ verifiedGone: true });
    expect(f.allocator.release).not.toHaveBeenCalled();
    expect(f.allocator.verifyGone).not.toHaveBeenCalled();
    expect(await f.vault.getProductionDatabaseIntent(f.owner)).toMatchObject({
      state: "releasing",
      providerProjectId: null,
    });
  });

  it("does not dispatch when intent persistence fails", async () => {
    const f = await fixture();
    f.storage.failNextCommit = true;
    expect((await run(f, "ensure", "claim-write-failure")).status).toBe(503);
    expect(f.effects.posts).toBe(0);
    expect(await f.vault.getProductionDatabaseIntent(f.owner)).toBeNull();
  });

  it("retains a committed claim when its acknowledgment is lost", async () => {
    const f = await fixture();
    const claim = f.vault.claimProductionDatabaseDispatch.bind(f.vault);
    vi.spyOn(f.vault, "claimProductionDatabaseDispatch").mockImplementation(async (input) => {
      await claim(input);
      throw new Error("synthetic lost acknowledgment");
    });
    expect((await run(f, "ensure", "claim-ack-failure")).status).toBe(503);
    f.vault = new CapabilityVaultDurableObject(f.state, f.env);
    expect((await run(f, "ensure", "claim-ack-retry")).status).toBe(503);
    expect(f.effects.posts).toBe(0);
    expect(await f.vault.getProductionDatabaseIntent(f.owner)).toMatchObject({
      state: "dispatched",
    });
  });

  it("releases a provider-known allocation after URI failure without requiring a ready capability", async () => {
    const f = await fixture();
    f.allocator.ensure.mockImplementation(async (input) => {
      await input.beforeCreate!(scope);
      f.effects.posts += 1;
      await input.onProjectResolved!({
        ...scope,
        providerProjectId: f.material.allocation.providerProjectId,
      });
      throw new ProductionDatabaseProviderError(
        502,
        "production_database_provider_rejected",
        false,
        "malformed_response",
      );
    });
    expect((await run(f, "ensure", "uri-failure")).status).toBe(502);
    expect(await f.vault.getProductionDatabaseAllocation(f.owner)).toBeNull();
    expect(await f.vault.getProductionDatabaseIntent(f.owner)).toMatchObject({
      state: "provider-known",
    });
    const release = await run(f, "release", "known-release");
    expect(release.status).toBe(200);
    expect(await release.json()).toMatchObject({ verifiedGone: true });
    expect(f.allocator.release).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "releasing",
        providerProjectId: f.material.allocation.providerProjectId,
      }),
      expect.any(Function),
    );
    expect(f.allocator.verifyGone).toHaveBeenCalledTimes(1);
    expect(await f.vault.getProductionDatabaseIntent(f.owner)).toMatchObject({
      state: "released",
      scope: null,
      providerProjectId: null,
    });
    expect(JSON.stringify([...f.storage.values.values()])).not.toContain(
      f.material.connectionString,
    );
  });

  it("retains an unresolved release for an empty legacy vault and refuses later creation", async () => {
    const f = await fixture();
    expect((await run(f, "release", "empty-release")).status).toBe(503);
    expect(await f.vault.getProductionDatabaseIntent(f.owner)).toMatchObject({
      state: "releasing",
      scope: null,
      providerProjectId: null,
    });
    expect(f.allocator.resolveForRelease).not.toHaveBeenCalled();
    f.vault = new CapabilityVaultDurableObject(f.state, f.env);
    expect((await run(f, "ensure", "late-ensure")).status).toBe(409);
    expect(f.allocator.ensure).not.toHaveBeenCalled();
    expect(f.effects.posts).toBe(0);
  });

  it("fences credential handoff when release starts after the provider resolves", async () => {
    const f = await fixture();
    const provision = f.vault.provisionProductionDatabase.bind(f.vault);
    vi.spyOn(f.vault, "provisionProductionDatabase").mockImplementation(async (input) => {
      await f.vault.beginProductionDatabaseRelease(f.owner);
      return provision(input);
    });
    expect((await run(f, "ensure", "release-during-handoff")).status).toBe(409);
    expect(f.effects.posts).toBe(1);
    expect(f.vault.provisionProductionDatabase).toHaveBeenCalledOnce();
    expect(await f.vault.getProductionDatabaseAllocation(f.owner)).toBeNull();
    expect(await f.vault.getProductionDatabaseIntent(f.owner)).toMatchObject({
      state: "releasing",
    });
    expect((await run(f, "release", "finish-handoff-release")).status).toBe(200);
  });

  it.each(["expiry", "generation"] as const)(
    "refuses POST after authority %s changes",
    async (change) => {
      const f = await fixture();
      const ensure = f.allocator.ensure.getMockImplementation()!;
      f.allocator.ensure.mockImplementation(async (input) => {
        if (change === "expiry") vi.setSystemTime(TEST_NOW_MS + 15_000);
        else {
          for (const job of f.coordinator.runtimeLifecycleJobs.values()) {
            if (job.kind === "production-database" && job.state === "active") {
              job.ownerId = "replacement-owner";
              job.attempt += 1;
            }
          }
        }
        return ensure(input);
      });
      expect((await run(f, "ensure", "authority-" + change)).status).toBe(409);
      expect(f.effects.posts).toBe(0);
      expect(await f.vault.getProductionDatabaseIntent(f.owner)).toBeNull();
    },
  );

  it.each([
    ["ensure", "ownership-verified"],
    ["ensure", "provider-complete"],
    ["ensure", "provider-verified"],
    ["ensure", "vault-complete"],
    ["release", "provider-complete"],
    ["release", "provider-verified"],
    ["release", "vault-complete"],
    ["release", "finalized"],
  ] as const)("resumes %s at %s without a backward checkpoint", async (action, checkpoint) => {
    const f = await fixture();
    expect((await run(f, "ensure", "seed-ready")).status).toBe(200);
    const key = "resume-" + action + "-" + checkpoint;
    const accepted = await handleControlRequest(
      await signedRequest({
        path,
        method: action === "ensure" ? "PUT" : "DELETE",
        body: {
          ...f.owner,
          action,
          expectedDeploymentVersion: "worker-version-test-1",
          ...(action === "ensure"
            ? { admission: productionDatabaseAdmissionFixture(f.owner, "authorized") }
            : {}),
        },
        nonce: `production-database-durability-${key}`,
        idempotencyKey: key,
      }),
      f.env,
      { coordinator: f.coordinator, backend: f.backend, nowMs: TEST_NOW_MS },
    );
    expect(accepted.status).toBe(409);
    const job = [...f.coordinator.runtimeLifecycleJobs.values()].find(
      (item) => item.kind === "production-database" && item.state === "active",
    )!;
    job.checkpoint = checkpoint;
    job.ownerId = "previous-owner";
    job.attempt = 1;
    job.leaseUntilMs = TEST_NOW_MS - 1;
    if (action === "release" && ["vault-complete", "finalized"].includes(checkpoint)) {
      await f.vault.beginProductionDatabaseRelease(f.owner);
      await f.allocator.verifyGone({ ...f.material.allocation, state: "releasing" });
      await f.vault.completeProductionDatabaseRelease({
        ...f.owner,
        expectedProviderProjectId: f.material.allocation.providerProjectId,
      });
    }
    const writeCheckpoint = f.coordinator.checkpointDurableOperation.bind(f.coordinator);
    vi.spyOn(f.coordinator, "checkpointDurableOperation").mockImplementation(async (input) => {
      const previous = await f.coordinator.getDurableOperation(input.jobKey);
      expect(
        checkpoints.indexOf(input.checkpoint as (typeof checkpoints)[number]),
      ).toBeGreaterThanOrEqual(
        checkpoints.indexOf(previous!.checkpoint as (typeof checkpoints)[number]),
      );
      return writeCheckpoint(input);
    });
    await drainArtifactCommitQueue({
      env: f.env,
      coordinator: f.coordinator,
      backend: f.backend,
      vault: f.vault,
      productionDatabaseAllocator: f.allocator,
    });
    expect(await f.coordinator.getDurableOperation(job.jobKey)).toMatchObject({
      state: "succeeded",
      checkpoint: "finalized",
      attempt: 2,
    });
    expect(f.effects.posts).toBe(1);
  });

  it("does not trust an old released tombstone without versioned absence evidence", async () => {
    const f = await fixture();
    f.storage.values.set("intent:production:neon-postgres", {
      version: 1,
      ...f.owner,
      state: "released",
      scope: null,
      providerProjectId: null,
      createdAt: new Date(TEST_NOW_MS).toISOString(),
      updatedAt: new Date(TEST_NOW_MS).toISOString(),
    });
    expect((await run(f, "release", "legacy-unmarked-release")).status).toBe(503);
    expect(await f.vault.getProductionDatabaseIntent(f.owner)).toMatchObject({
      state: "releasing",
      scope: null,
    });
    expect(f.allocator.ensure).not.toHaveBeenCalled();
    expect(f.allocator.resolveForRelease).not.toHaveBeenCalled();
    expect(f.allocator.verifyGone).not.toHaveBeenCalled();
  });

  it("recovers and commits known ownership before DELETE without allocating or fetching credentials", async () => {
    const f = await fixture();
    await f.vault.claimProductionDatabaseDispatch({
      ...f.owner,
      scope,
      expiresAtMs: TEST_NOW_MS + 60_000,
    });
    f.allocator.resolveForRelease.mockImplementation(async (input) => {
      await input.assertAuthority();
      return { ...f.material.allocation, state: "releasing" };
    });
    f.allocator.release.mockImplementation(async () => {
      expect(await f.vault.getProductionDatabaseIntent(f.owner)).toMatchObject({
        state: "releasing",
        providerProjectId: f.material.allocation.providerProjectId,
      });
      expect(await f.vault.getProductionDatabaseAllocation(f.owner)).toBeNull();
    });
    const response = await run(f, "release", "recover-provider-owned");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ verifiedGone: true });
    expect(f.allocator.ensure).not.toHaveBeenCalled();
    expect(f.effects.posts).toBe(0);
    expect(f.allocator.verifyGone).toHaveBeenCalledWith(
      expect.objectContaining({ providerProjectId: f.material.allocation.providerProjectId }),
      expect.any(Function),
    );
    expect(await f.vault.getProductionDatabaseIntent(f.owner)).toMatchObject({
      state: "released",
      completionEvidence: { version: 1, kind: "exact-provider-id-get-404" },
    });
  });

  it("does not certify an uncertain dispatch from zero matches", async () => {
    const f = await fixture();
    await f.vault.claimProductionDatabaseDispatch({
      ...f.owner,
      scope,
      expiresAtMs: TEST_NOW_MS + 60_000,
    });
    expect((await run(f, "release", "empty-discovery-after-dispatch")).status).toBe(503);
    expect(f.allocator.resolveForRelease).toHaveBeenCalledOnce();
    expect(f.allocator.release).not.toHaveBeenCalled();
    expect(await f.vault.getProductionDatabaseIntent(f.owner)).toMatchObject({
      state: "releasing",
      providerProjectId: null,
    });
  });

  it("retains an unresolved receipt when recovered ownership cannot commit", async () => {
    const f = await fixture();
    await f.vault.claimProductionDatabaseDispatch({
      ...f.owner,
      scope,
      expiresAtMs: TEST_NOW_MS + 60_000,
    });
    f.allocator.resolveForRelease.mockResolvedValue({
      ...f.material.allocation,
      state: "releasing",
    });
    vi.spyOn(f.vault, "recordProductionDatabaseProject").mockRejectedValue(
      new Error("synthetic ownership write failure"),
    );
    expect((await run(f, "release", "recovered-ownership-write-failure")).status).toBe(503);
    expect(f.allocator.release).not.toHaveBeenCalled();
    expect(f.allocator.verifyGone).not.toHaveBeenCalled();
  });

  it.each(["expiry", "generation", "deadline"] as const)(
    "rejects recovered ownership after authority %s changes",
    async (change) => {
      const f = await fixture();
      await f.vault.claimProductionDatabaseDispatch({
        ...f.owner,
        scope,
        expiresAtMs: TEST_NOW_MS + 60_000,
      });
      const record = vi.spyOn(f.vault, "recordProductionDatabaseProject");
      f.allocator.resolveForRelease.mockImplementation(async () => {
        if (change === "expiry") vi.setSystemTime(TEST_NOW_MS + 15_000);
        else
          for (const job of f.coordinator.runtimeLifecycleJobs.values()) {
            if (job.kind === "production-database" && job.state === "active") {
              if (change === "deadline") job.deadlineMs = TEST_NOW_MS;
              else {
                job.ownerId = "replacement-owner";
                job.attempt += 1;
              }
            }
          }
        return { ...f.material.allocation, state: "releasing" };
      });
      expect((await run(f, "release", "recovery-authority-" + change)).status).toBe(409);
      expect(record).not.toHaveBeenCalled();
      expect(f.allocator.release).not.toHaveBeenCalled();
    },
  );

  it("does not complete proof after authority is lost during DELETE", async () => {
    const f = await fixture();
    expect((await run(f, "ensure", "seed-before-delete-authority-loss")).status).toBe(200);
    f.allocator.release.mockImplementation(async () => {
      for (const job of f.coordinator.runtimeLifecycleJobs.values()) {
        if (job.kind === "production-database" && job.state === "active")
          job.ownerId = "replacement-owner";
      }
    });
    expect((await run(f, "release", "delete-authority-loss")).status).toBe(409);
    expect(f.allocator.verifyGone).not.toHaveBeenCalled();
    expect(await f.vault.getProductionDatabaseIntent(f.owner)).toMatchObject({
      state: "releasing",
    });
  });
});
