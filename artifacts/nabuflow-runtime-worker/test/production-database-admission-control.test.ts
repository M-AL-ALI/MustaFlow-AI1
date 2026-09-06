import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  productionDatabaseAllocationIdentity,
  PRODUCTION_DATABASE_PROVIDER_OPERATION_BOUND_MS,
  type ProductionDatabaseAllocationRecord,
} from "@workspace/tenant-runtime-contracts";
import { CapabilityVaultDurableObject } from "../src/capability-vault-durable-object";
import type {
  ProductionDatabaseLegacyReleaseResolution,
  ProductionDatabaseLegacyReleaseResolutionInput,
} from "../src/production-database-allocator";
import type { ProductionDatabaseEnsureInput } from "../src/production-database-intent";
import { handleControlRequest } from "../src/worker";
import {
  MemoryCoordinator,
  MockBackend,
  TEST_NOW_MS,
  TEST_DATABASE_ADMISSION_EPOCH,
  fakeEnv,
  signedRequest,
  mutationAndDrain,
  drainArtifactCommitQueue,
  productionDatabaseAdmissionFixture,
} from "./helpers";

const path = "/_nabuflow/control/v1/capabilities/42/neon-postgres/database/production-allocation";
const otherEpoch = "23b8ba22-503b-4a79-84f5-39c219cff001";
const scope = {
  providerOrganizationId: "org-production",
  regionId: "aws-us-east-2",
  historyRetentionSeconds: 604_800,
};

class AdmissionStorage {
  readonly values = new Map<string, unknown>();
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
  transaction<T>(work: (transaction: AdmissionStorage) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const before = structuredClone(this.values);
      try {
        return await work(this);
      } catch (error) {
        this.values.clear();
        for (const [key, value] of before) this.values.set(key, value);
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
  const coordinator = new MemoryCoordinator();
  const backend = new MockBackend();
  const storage = new AdmissionStorage();
  const vault = new CapabilityVaultDurableObject({ storage } as unknown as DurableObjectState, env);
  const owner = {
    projectId: 42,
    allocationIdentity: await productionDatabaseAllocationIdentity({
      format: "nabuflow.production-database-allocation/v1",
      deploymentNamespace: "production",
      projectId: 42,
    }),
  };
  const allocation: ProductionDatabaseAllocationRecord = {
    format: "nabuflow.production-database-allocation/v1",
    ...owner,
    ...scope,
    provider: "neon-postgres",
    providerProjectId: "admission-owned-project",
    revision: "production-database-" + owner.allocationIdentity.slice(0, 48),
    state: "ready",
    createdAt: new Date(TEST_NOW_MS).toISOString(),
    updatedAt: new Date(TEST_NOW_MS).toISOString(),
  };
  const effects = { posts: 0 };
  const allocator = {
    ensure: vi.fn(async (input: ProductionDatabaseEnsureInput) => {
      await input.beforeCreate!(scope);
      effects.posts += 1;
      await input.onProjectResolved!({ ...scope, providerProjectId: allocation.providerProjectId });
      return {
        allocation: structuredClone(allocation),
        connectionString: "postgresql://test:test@ep-admission.us-east-2.aws.neon.tech/neondb",
        reused: false,
      };
    }),
    release: vi.fn(async (_allocation: ProductionDatabaseAllocationRecord) => undefined),
    verifyGone: vi.fn(async (_allocation: ProductionDatabaseAllocationRecord) => true),
    resolveForRelease: vi.fn(async () => null),
    resolveLegacyForRelease: vi.fn(
      async (
        input: ProductionDatabaseLegacyReleaseResolutionInput,
      ): Promise<ProductionDatabaseLegacyReleaseResolution> => ({
        state: "absent",
        proof: {
          providerOrganizationId: scope.providerOrganizationId,
          expectedProjectName: `nabuflow-production-${input.allocationIdentity.slice(0, 24)}`,
          catalogDigestSha256: "a".repeat(64),
          catalogProjectCount: 3,
          catalogOwnedProjectCount: 2,
          catalogPageCount: 1,
          verifiedAt: new Date(Date.now()).toISOString(),
        },
      }),
    ),
  };
  const authorized = productionDatabaseAdmissionFixture(owner, "authorized", true);
  const sealed = productionDatabaseAdmissionFixture(owner, "sealed", true);
  const dependencies = {
    coordinator,
    backend,
    vault,
    productionDatabaseAllocator: allocator,
    nowMs: TEST_NOW_MS,
  };
  return {
    env,
    coordinator,
    backend,
    storage,
    vault,
    owner,
    allocation,
    allocator,
    effects,
    authorized,
    sealed,
    dependencies,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function body(f: Fixture, action: "ensure" | "release", admission?: unknown) {
  return {
    ...f.owner,
    action,
    expectedDeploymentVersion: "worker-version-test-1",
    ...(admission === undefined ? {} : { admission }),
  };
}
function submit(f: Fixture, action: "ensure" | "release", admission: unknown, key: string) {
  return mutationAndDrain({
    path,
    method: action === "ensure" ? "PUT" : "DELETE",
    body: body(f, action, admission),
    nonce: "production-admission-" + key,
    idempotencyKey: "production-admission-" + key,
    env: f.env,
    ...f.dependencies,
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

describe("production database admission at HTTP and durable execution boundaries", () => {
  it.each(["missing", "invalid", "valid"] as const)(
    "advertises admission only for a valid configured epoch: %s",
    async (state) => {
      const f = await fixture();
      if (state === "missing") delete f.env.NABUFLOW_PRODUCTION_DATABASE_ADMISSION_EPOCH;
      if (state === "invalid") f.env.NABUFLOW_PRODUCTION_DATABASE_ADMISSION_EPOCH = "invalid";
      const response = await handleControlRequest(
        await signedRequest({
          path: "/_nabuflow/control/v1/version",
          nonce: "production-admission-version-" + state,
        }),
        f.env,
        f.dependencies,
      );
      expect(response.status).toBe(200);
      const result = (await response.json()) as { features: string[] };
      expect(result.features.includes("production-database-admission-v1")).toBe(state === "valid");
    },
  );

  it.each(["missing", "invalid"] as const)(
    "rejects ensure with %s configured epoch before registration",
    async (state) => {
      const f = await fixture();
      if (state === "missing") delete f.env.NABUFLOW_PRODUCTION_DATABASE_ADMISSION_EPOCH;
      else f.env.NABUFLOW_PRODUCTION_DATABASE_ADMISSION_EPOCH = "invalid";
      const response = await submit(f, "ensure", f.authorized, "unconfigured-" + state);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "production_database_admission_unconfigured",
        retryable: false,
      });
      expect(f.coordinator.runtimeLifecycleJobs.size).toBe(0);
      expect(f.effects.posts).toBe(0);
    },
  );

  it.each([
    ["missing", 409, "production_database_admission_required"],
    ["epoch", 409, "production_database_admission_epoch_mismatch"],
    ["project", 409, "production_database_admission_owner_mismatch"],
    ["allocation", 409, "production_database_admission_owner_mismatch"],
    ["assertion", 400, "invalid_request"],
    ["issuer", 400, "invalid_request"],
    ["audience", 400, "invalid_request"],
  ] as const)(
    "rejects %s admission at HTTP acceptance with zero provider calls",
    async (kind, status, code) => {
      const f = await fixture();
      let receipt: unknown = f.authorized;
      if (kind === "missing") receipt = undefined;
      if (kind === "epoch") receipt = { ...f.authorized, registrationEpoch: otherEpoch };
      if (kind === "project") receipt = { ...f.authorized, projectId: 51 };
      if (kind === "allocation") receipt = { ...f.authorized, allocationIdentity: "f".repeat(64) };
      if (kind === "assertion") receipt = f.sealed;
      if (kind === "issuer") receipt = { ...f.authorized, issuer: "untrusted" };
      if (kind === "audience") receipt = { ...f.authorized, audience: "staging" };
      const response = await submit(f, "ensure", receipt, "bad-" + kind);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
      expect(f.coordinator.runtimeLifecycleJobs.size).toBe(0);
      expect(f.allocator.ensure).not.toHaveBeenCalled();
      expect(await f.vault.getProductionDatabaseIntent(f.owner)).toBeNull();
    },
  );

  it.each(["old-body", "changed-epoch", "missing-epoch", "wrong-assertion"] as const)(
    "terminalizes queued %s before a dispatch claim or POST",
    async (kind) => {
      const f = await fixture();
      const claim = vi.spyOn(f.vault, "claimProductionDatabaseDispatch");
      const accepted = await handleControlRequest(
        await signedRequest({
          path,
          method: "PUT",
          body: body(f, "ensure", f.authorized),
          nonce: "production-admission-queue-" + kind,
          idempotencyKey: "production-admission-queue-" + kind,
        }),
        f.env,
        f.dependencies,
      );
      expect(accepted.status).toBe(409);
      const job = [...f.coordinator.runtimeLifecycleJobs.values()].find(
        (item) => item.kind === "production-database",
      );
      if (job?.kind !== "production-database") throw new Error("expected queued database job");
      if (kind === "old-body") delete job.request.admission;
      if (kind === "changed-epoch") f.env.NABUFLOW_PRODUCTION_DATABASE_ADMISSION_EPOCH = otherEpoch;
      if (kind === "missing-epoch") delete f.env.NABUFLOW_PRODUCTION_DATABASE_ADMISSION_EPOCH;
      if (kind === "wrong-assertion") job.request.admission = f.sealed;
      await drainArtifactCommitQueue({ env: f.env, ...f.dependencies });
      const terminal = await f.coordinator.getDurableOperation(job.jobKey);
      expect(terminal).toMatchObject({ state: "failed", response: { body: { retryable: false } } });
      expect(terminal?.response?.body).toMatchObject({
        code:
          kind === "old-body"
            ? "production_database_admission_required"
            : kind === "missing-epoch"
              ? "production_database_admission_unconfigured"
              : kind === "changed-epoch"
                ? "production_database_admission_epoch_mismatch"
                : "production_database_admission_invalid",
      });
      expect(claim).not.toHaveBeenCalled();
      expect(f.effects.posts).toBe(0);
      expect(await f.vault.getProductionDatabaseIntent(f.owner)).toBeNull();
    },
  );

  it("atomically closes a sealed birth, replays the same proof, and blocks late ensure", async () => {
    const f = await fixture();
    const complete = vi.spyOn(f.vault, "completeNeverDispatchedProductionDatabaseRelease");
    expect((await submit(f, "release", f.sealed, "sealed-birth")).status).toBe(200);
    const receipt = await f.vault.getProductionDatabaseIntent(f.owner);
    expect(receipt).toMatchObject({
      version: 2,
      state: "released",
      completionEvidence: {
        kind: "sealed-birth-no-dispatch",
        registrationEpoch: TEST_DATABASE_ADMISSION_EPOCH,
        receiptId: f.sealed.receiptId,
      },
    });
    expect((await submit(f, "release", f.sealed, "sealed-birth-retry")).status).toBe(200);
    expect(await f.vault.getProductionDatabaseIntent(f.owner)).toEqual(receipt);
    expect(complete).toHaveBeenCalledTimes(2);
    const late = await submit(f, "ensure", f.authorized, "late-authorized");
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({
      code: "production_database_release_in_progress",
      retryable: false,
    });
    expect(
      (
        await submit(
          f,
          "release",
          { ...f.sealed, receiptId: "13b8ba22-503b-4a79-84f5-39c219cff005" },
          "wrong-seal-replay",
        )
      ).status,
    ).toBe(409);
    expect(f.allocator.ensure).not.toHaveBeenCalled();
    expect(f.allocator.release).not.toHaveBeenCalled();
    expect(f.allocator.resolveForRelease).not.toHaveBeenCalled();
  });

  it.each(["legacy-no-receipt", "legacy-unregistered"] as const)(
    "does not fabricate negative proof for %s",
    async (kind) => {
      const f = await fixture();
      const complete = vi.spyOn(f.vault, "completeNeverDispatchedProductionDatabaseRelease");
      const receipt =
        kind === "legacy-no-receipt" ? undefined : { ...f.sealed, birthRegistered: false };
      expect((await submit(f, "release", receipt, kind)).status).toBe(503);
      expect(await f.vault.getProductionDatabaseIntent(f.owner)).toMatchObject({
        state: "releasing",
        providerProjectId: null,
      });
      expect(complete).not.toHaveBeenCalled();
      expect(f.allocator.resolveLegacyForRelease).not.toHaveBeenCalled();
    },
  );

  it("completes a drained sealed legacy absence once, replays it, and blocks later allocation", async () => {
    const f = await fixture();
    const sealedLegacy = { ...f.sealed, birthRegistered: false };
    vi.setSystemTime(TEST_NOW_MS - PRODUCTION_DATABASE_PROVIDER_OPERATION_BOUND_MS);
    expect((await submit(f, "release", sealedLegacy, "leg-fence")).status).toBe(503);
    vi.setSystemTime(TEST_NOW_MS);
    const completed = await submit(f, "release", sealedLegacy, "leg-abs");
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({
      verifiedGone: true,
      providerProjectId: null,
    });
    const receipt = await f.vault.getProductionDatabaseIntent(f.owner);
    expect(receipt).toMatchObject({
      version: 3,
      state: "released",
      completionEvidence: {
        kind: "sealed-legacy-catalog-absence",
        registrationEpoch: TEST_DATABASE_ADMISSION_EPOCH,
        providerOrganizationId: scope.providerOrganizationId,
        catalogDigestSha256: "a".repeat(64),
      },
    });
    const replay = await submit(f, "release", sealedLegacy, "leg-replay");
    const replayBody = await replay.json();
    expect(replay.status, JSON.stringify(replayBody)).toBe(200);
    expect(replayBody).toMatchObject({ verifiedGone: true, providerProjectId: null });
    expect(f.allocator.resolveLegacyForRelease).toHaveBeenCalledOnce();
    const late = await submit(f, "ensure", f.authorized, "leg-late");
    expect(late.status).toBe(409);
    expect(f.allocator.ensure).not.toHaveBeenCalled();
  });

  it("adopts and deletes an exact legacy catalog match instead of recording absence", async () => {
    const f = await fixture();
    const sealedLegacy = { ...f.sealed, birthRegistered: false };
    vi.setSystemTime(TEST_NOW_MS - PRODUCTION_DATABASE_PROVIDER_OPERATION_BOUND_MS);
    expect((await submit(f, "release", sealedLegacy, "legacy-match-fence")).status).toBe(503);
    vi.setSystemTime(TEST_NOW_MS);
    f.allocator.resolveLegacyForRelease.mockResolvedValueOnce({
      state: "found",
      allocation: { ...f.allocation, state: "releasing" },
    });
    const completed = await submit(f, "release", sealedLegacy, "legacy-match-delete");
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({
      verifiedGone: true,
      providerProjectId: f.allocation.providerProjectId,
    });
    expect(f.allocator.release).toHaveBeenCalledOnce();
    expect(f.allocator.verifyGone).toHaveBeenCalledOnce();
    expect(await f.vault.getProductionDatabaseIntent(f.owner)).toMatchObject({
      version: 1,
      completionEvidence: { kind: "exact-provider-id-get-404" },
    });
  });

  it("rejects a contradictory capability atomically without deleting it", async () => {
    const f = await fixture();
    const key = "capability:neon-postgres:database";
    f.storage.values.set(key, { sentinel: "existing-capability" });
    expect((await submit(f, "release", f.sealed, "capability-contradiction")).status).toBe(409);
    expect(f.storage.values.get(key)).toEqual({ sentinel: "existing-capability" });
    expect(await f.vault.getProductionDatabaseIntent(f.owner)).toBeNull();
    expect(f.allocator.release).not.toHaveBeenCalled();
  });

  it("retains uncertain dispatch despite a valid sealed birth", async () => {
    const f = await fixture();
    await f.vault.claimProductionDatabaseDispatch({
      ...f.owner,
      scope,
      expiresAtMs: TEST_NOW_MS + 60_000,
    });
    const complete = vi.spyOn(f.vault, "completeNeverDispatchedProductionDatabaseRelease");
    expect((await submit(f, "release", f.sealed, "uncertain-dispatch")).status).toBe(503);
    expect(await f.vault.getProductionDatabaseIntent(f.owner)).toMatchObject({
      state: "releasing",
      providerProjectId: null,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(f.allocator.resolveForRelease).toHaveBeenCalledOnce();
    expect(f.effects.posts).toBe(0);
  });

  it.each(["legacy", "sealed"] as const)(
    "preserves positive owned-resource cleanup for %s release",
    async (kind) => {
      const f = await fixture();
      expect((await submit(f, "ensure", f.authorized, "create-" + kind)).status).toBe(200);
      const complete = vi.spyOn(f.vault, "completeNeverDispatchedProductionDatabaseRelease");
      if (kind === "legacy") delete f.env.NABUFLOW_PRODUCTION_DATABASE_ADMISSION_EPOCH;
      const response = await submit(
        f,
        "release",
        kind === "sealed" ? f.sealed : undefined,
        "positive-" + kind,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        verifiedGone: true,
        providerProjectId: f.allocation.providerProjectId,
      });
      expect(f.effects.posts).toBe(1);
      expect(f.allocator.release).toHaveBeenCalledOnce();
      expect(f.allocator.verifyGone).toHaveBeenCalledOnce();
      expect(complete).not.toHaveBeenCalled();
      expect(await f.vault.getProductionDatabaseIntent(f.owner)).toMatchObject({
        version: 1,
        completionEvidence: { kind: "exact-provider-id-get-404" },
      });
    },
  );
});
