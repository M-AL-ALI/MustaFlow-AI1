import { productionDatabaseAllocationIdentity } from "@workspace/tenant-runtime-contracts";
import { describe, expect, it } from "vitest";
import { handleControlRequest } from "../src/worker";
import type { ProductionDatabaseAllocator } from "../src/production-database-allocator";
import {
  MemoryCapabilityVault,
  MemoryCoordinator,
  MockBackend,
  TEST_NOW_MS,
  fakeEnv,
  mutationAndDrain,
  signedRequest,
} from "./helpers";

describe("production database durable control path", () => {
  it("allocates once, survives release changes, and releases only on explicit deletion", async () => {
    const env = Object.assign(fakeEnv(), {
      NABUFLOW_PRODUCTION_DATABASE_ALLOCATION_ENABLED: "enabled",
      NABUFLOW_STAGING_PRODUCTION_DATABASE_REHEARSAL: "enabled",
      NABUFLOW_PRODUCTION_NEON_MANAGEMENT_KEY: "test-management-material-with-sufficient-length",
      NABUFLOW_PRODUCTION_NEON_ORGANIZATION_ID: "org-production-rehearsal",
      NABUFLOW_PRODUCTION_NEON_REGION_ID: "aws-us-east-2",
      NABUFLOW_PRODUCTION_NEON_HISTORY_RETENTION_SECONDS: "604800",
      NABUFLOW_PRODUCTION_DATABASE_MAX_PROJECTS: "20",
    });
    const coordinator = new MemoryCoordinator();
    const vault = new MemoryCapabilityVault();
    const backend = new MockBackend();
    const allocationIdentity = await productionDatabaseAllocationIdentity({
      format: "nabuflow.production-database-allocation/v1",
      deploymentNamespace: "production",
      projectId: 42,
    });
    const connectionString =
      "postgresql://runtime:transient@ep-production-rehearsal.us-east-2.aws.neon.tech/neondb";
    let ensureCalls = 0;
    let releaseCalls = 0;
    let verifyCalls = 0;
    const allocator: Pick<ProductionDatabaseAllocator, "ensure" | "release" | "verifyGone"> = {
      async ensure(input) {
        ensureCalls += 1;
        return {
          allocation: {
            format: "nabuflow.production-database-allocation/v1",
            projectId: input.projectId,
            allocationIdentity: input.allocationIdentity,
            provider: "neon-postgres",
            providerProjectId: "provider-project-rehearsal",
            providerOrganizationId: "org-production-rehearsal",
            regionId: "aws-us-east-2",
            historyRetentionSeconds: 604_800,
            revision: `production-database-${input.allocationIdentity.slice(0, 48)}`,
            state: "ready",
            createdAt: "2026-08-15T12:00:00.000Z",
            updatedAt: "2026-08-15T12:00:00.000Z",
          },
          connectionString,
          reused: false,
        };
      },
      async release(allocation) {
        releaseCalls += 1;
        expect(allocation.state).toBe("releasing");
      },
      async verifyGone() {
        verifyCalls += 1;
        return true;
      },
    };
    const path =
      "/_nabuflow/control/v1/capabilities/42/neon-postgres/database/production-allocation";
    const version = await handleControlRequest(
      await signedRequest({
        path: "/_nabuflow/control/v1/version",
        nonce: "production-database-version",
      }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    await expect(version.json()).resolves.toMatchObject({
      features: expect.arrayContaining(["production-database-v1"]),
    });
    const request = {
      action: "ensure" as const,
      projectId: 42,
      expectedDeploymentVersion: "worker-version-test-1",
      allocationIdentity,
    };

    const created = await mutationAndDrain({
      path,
      method: "PUT",
      body: request,
      nonce: "production-database-ensure-created",
      idempotencyKey: `production-database:${allocationIdentity}:ensure:first`,
      env,
      coordinator,
      backend,
      vault,
      productionDatabaseAllocator: allocator,
    });
    expect(created.status).toBe(200);
    const createdText = await created.text();
    expect(createdText).not.toContain(connectionString);
    expect(JSON.parse(createdText)).toMatchObject({
      ok: true,
      projectId: 42,
      allocationIdentity,
      state: "ready",
      reused: false,
    });
    expect(vault.databaseRecords.get(42)?.credential).toBe(connectionString);
    expect(vault.productionDatabaseAllocations.get(42)?.state).toBe("ready");
    expect(ensureCalls).toBe(1);

    const nextRelease = await mutationAndDrain({
      path,
      method: "PUT",
      body: { ...request, expectedDeploymentVersion: "worker-version-test-1" },
      nonce: "production-database-ensure-next-release",
      idempotencyKey: `production-database:${allocationIdentity}:ensure:next-release`,
      env,
      coordinator,
      backend,
      vault,
      productionDatabaseAllocator: allocator,
    });
    expect(nextRelease.status).toBe(200);
    await expect(nextRelease.json()).resolves.toMatchObject({ reused: true });
    expect(ensureCalls).toBe(1);
    expect(vault.productionDatabaseAllocations.get(42)?.providerProjectId).toBe(
      "provider-project-rehearsal",
    );

    const released = await mutationAndDrain({
      path,
      method: "DELETE",
      body: { ...request, action: "release" },
      nonce: "production-database-release",
      idempotencyKey: `production-database:${allocationIdentity}:release`,
      env,
      coordinator,
      backend,
      vault,
      productionDatabaseAllocator: allocator,
    });
    expect(released.status).toBe(200);
    await expect(released.json()).resolves.toMatchObject({
      state: "released",
      verifiedGone: true,
    });
    expect(releaseCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(vault.productionDatabaseAllocations.has(42)).toBe(false);
    expect(vault.databaseRecords.has(42)).toBe(false);

    const jobs = [...coordinator.runtimeLifecycleJobs.values()].filter(
      (job) => job.kind === "production-database",
    );
    expect(jobs).toHaveLength(3);
    expect(jobs.every((job) => job.state === "succeeded" && job.checkpoint === "finalized")).toBe(
      true,
    );
    expect(JSON.stringify(jobs)).not.toContain(connectionString);
    const diagnostics = await handleControlRequest(
      await signedRequest({
        path: `${path}/${allocationIdentity}/diagnostics`,
        nonce: "production-database-diagnostics",
      }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    expect(diagnostics.status).toBe(200);
    await expect(diagnostics.json()).resolves.toMatchObject({
      job: {
        kind: "production-database",
        allocationIdentity,
        action: "release",
        state: "succeeded",
        checkpoint: "finalized",
      },
    });
    expect(TEST_NOW_MS).toBeGreaterThan(0);
  });

  it("rejects a noncanonical allocation identity before provider or vault mutation", async () => {
    const env = Object.assign(fakeEnv(), {
      NABUFLOW_PRODUCTION_DATABASE_ALLOCATION_ENABLED: "enabled",
      NABUFLOW_STAGING_PRODUCTION_DATABASE_REHEARSAL: "enabled",
    });
    const coordinator = new MemoryCoordinator();
    const vault = new MemoryCapabilityVault();
    let ensureCalls = 0;
    const allocator = {
      async ensure() {
        ensureCalls += 1;
        throw new Error("must not run");
      },
      async release() {},
      async verifyGone() {
        return false;
      },
    } as Pick<ProductionDatabaseAllocator, "ensure" | "release" | "verifyGone">;
    const response = await mutationAndDrain({
      path: "/_nabuflow/control/v1/capabilities/42/neon-postgres/database/production-allocation",
      method: "PUT",
      body: {
        action: "ensure",
        projectId: 42,
        expectedDeploymentVersion: "worker-version-test-1",
        allocationIdentity: "f".repeat(64),
      },
      nonce: "production-database-identity-conflict",
      idempotencyKey: "production-database-identity-conflict",
      env,
      coordinator,
      backend: new MockBackend(),
      vault,
      productionDatabaseAllocator: allocator,
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "production_database_identity_conflict",
    });
    expect(ensureCalls).toBe(0);
    expect(vault.productionDatabaseAllocations.size).toBe(0);
  });
});
