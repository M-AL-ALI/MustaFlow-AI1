import { afterEach, describe, expect, it, vi } from "vitest";
import {
  productionDatabaseAllocationIdentity,
  productionDatabaseCapabilityDefinition,
  type ProductionDatabaseAdmissionReceipt,
} from "@workspace/tenant-runtime-contracts";
import type { WorkerBindings } from "../src/bindings";
import { CapabilityVaultDurableObject } from "../src/capability-vault-durable-object";
import {
  PRODUCTION_DATABASE_INTENT_STORAGE_KEY,
  type ProductionDatabaseIntent,
  type ProductionDatabaseIntentOwner,
} from "../src/production-database-intent";

const CAPABILITY_KEY = "capability:neon-postgres:database";
const ALLOCATION_KEY = "allocation:production:neon-postgres";
const timestamp = "2026-09-03T00:00:00.000Z";
const scope = {
  providerOrganizationId: "org-production",
  regionId: "aws-us-east-2",
  historyRetentionSeconds: 604800,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class MemoryTransaction {
  constructor(protected records = new Map<string, unknown>()) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return structuredClone(this.records.get(key)) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.records.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.records.delete(key);
  }

  snapshot() {
    return structuredClone(this.records);
  }
}

class AtomicMemoryStorage extends MemoryTransaction {
  private tail = Promise.resolve();
  private nextGate?: { entered: ReturnType<typeof deferred>; resumed: ReturnType<typeof deferred> };

  pauseNextTransaction() {
    const gate = { entered: deferred(), resumed: deferred() };
    this.nextGate = gate;
    return { entered: gate.entered.promise, resume: gate.resumed.resolve };
  }

  async transaction<T>(callback: (transaction: MemoryTransaction) => Promise<T>): Promise<T> {
    const previous = this.tail;
    const complete = deferred();
    this.tail = complete.promise;
    const gate = this.nextGate;
    this.nextGate = undefined;
    await previous;
    try {
      if (gate) {
        gate.entered.resolve();
        await gate.resumed.promise;
      }
      const transaction = new MemoryTransaction(this.snapshot());
      const result = await callback(transaction);
      this.records = transaction.snapshot();
      return result;
    } finally {
      complete.resolve();
    }
  }
}

function pauseEncryption() {
  const entered = deferred();
  const resumed = deferred();
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (algorithm, key, data) => {
    entered.resolve();
    await resumed.promise;
    return encrypt(algorithm, key, data);
  });
  return { entered: entered.promise, resume: resumed.resolve };
}

async function awaitGate(entered: Promise<void>, operation: Promise<unknown>) {
  await Promise.race([
    entered,
    operation.then(() => {
      throw new Error("Provisioning completed before the expected race gate");
    }),
  ]);
}

function sealedReceipt(owner: ProductionDatabaseIntentOwner): ProductionDatabaseAdmissionReceipt {
  return {
    format: "nabuflow.production-database-admission/v1",
    issuer: "nabuflow-api",
    audience: "production",
    ...owner,
    registrationEpoch: "11111111-1111-4111-8111-111111111111",
    birthToken: "22222222-2222-4222-8222-222222222222",
    assertion: "sealed",
    receiptId: "33333333-3333-4333-8333-333333333333",
    birthRegistered: true,
  };
}

function liveIntent(owner: ProductionDatabaseIntentOwner): ProductionDatabaseIntent {
  return {
    ...owner,
    version: 1,
    state: "provider-known",
    scope,
    providerProjectId: "neon-project-42",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function positiveRelease(owner: ProductionDatabaseIntentOwner): ProductionDatabaseIntent {
  return {
    ...liveIntent(owner),
    state: "released",
    scope: null,
    providerProjectId: null,
    completionEvidence: { version: 1, kind: "exact-provider-id-get-404", verifiedAt: timestamp },
  };
}

function negativeRelease(owner: ProductionDatabaseIntentOwner): ProductionDatabaseIntent {
  const receipt = sealedReceipt(owner);
  return {
    ...positiveRelease(owner),
    version: 2,
    completionEvidence: {
      version: 1,
      kind: "sealed-birth-no-dispatch",
      registrationEpoch: receipt.registrationEpoch,
      birthToken: receipt.birthToken,
      receiptId: receipt.receiptId,
      verifiedAt: timestamp,
    },
  };
}

function releasingAllocation(owner: ProductionDatabaseIntentOwner) {
  return {
    format: "nabuflow.production-database-allocation/v1",
    ...owner,
    provider: "neon-postgres",
    ...scope,
    providerProjectId: "neon-project-42",
    revision: "production-database-" + owner.allocationIdentity.slice(0, 48),
    state: "releasing",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function fixture(projectId = 42) {
  const owner = {
    projectId,
    allocationIdentity: await productionDatabaseAllocationIdentity({
      format: "nabuflow.production-database-allocation/v1",
      deploymentNamespace: "production",
      projectId,
    }),
  };
  const storage = new AtomicMemoryStorage();
  const env = {
    NABUFLOW_CAPABILITY_VAULT_ACTIVE_KEY_ID: "v1",
    // Synthetic base64url encoding of 32 zero bytes; never a production key.
    CLOUDFLARE_CAPABILITY_VAULT_KEK_V1: "A".repeat(43),
  } as WorkerBindings;
  const restart = () =>
    new CapabilityVaultDurableObject({ storage } as unknown as DurableObjectState, env);
  const request = {
    projectId,
    revision: "production-database-" + owner.allocationIdentity.slice(0, 48),
    definition: productionDatabaseCapabilityDefinition,
    credential: {
      kind: "neon-connection-string" as const,
      value: "postgresql://test:test@database.example.invalid/app",
    },
  };
  return { owner, storage, request, vault: restart(), restart };
}

afterEach(() => vi.restoreAllMocks());

describe("production database admission capability final-write fence", () => {
  it("rejects delayed encryption after an atomic negative seal wins", async () => {
    const f = await fixture();
    const gate = pauseEncryption();
    const provision = f.vault.provisionDatabase(f.request);
    await awaitGate(gate.entered, provision);
    try {
      await expect(
        f.vault.completeNeverDispatchedProductionDatabaseRelease({
          ...f.owner,
          receipt: sealedReceipt(f.owner),
        }),
      ).resolves.toBe("released");
    } finally {
      gate.resume();
    }
    await expect(provision).rejects.toThrow("production_database_intent_conflict");
    expect(await f.storage.get(CAPABILITY_KEY)).toBeUndefined();
    expect(await f.restart().getProductionDatabaseIntent(f.owner)).toMatchObject({
      version: 2,
      state: "released",
      completionEvidence: { kind: "sealed-birth-no-dispatch" },
    });
  });

  it("rejects a concurrent negative seal when the capability transaction wins first", async () => {
    const f = await fixture();
    const gate = f.storage.pauseNextTransaction();
    const provision = f.vault.provisionDatabase(f.request);
    await awaitGate(gate.entered, provision);
    const seal = f.vault.completeNeverDispatchedProductionDatabaseRelease({
      ...f.owner,
      receipt: sealedReceipt(f.owner),
    });
    const rejected = expect(seal).rejects.toThrow("production_database_intent_conflict");
    gate.resume();
    await expect(provision).resolves.toEqual({ state: "provisioned", keyId: "v1" });
    await rejected;
    expect(await f.storage.get(CAPABILITY_KEY)).toMatchObject({ projectId: f.owner.projectId });
    expect(await f.storage.get(PRODUCTION_DATABASE_INTENT_STORAGE_KEY)).toBeUndefined();
  });

  it("rejects delayed encryption after exact-ID positive release completion", async () => {
    const f = await fixture();
    const gate = pauseEncryption();
    const provision = f.vault.provisionDatabase(f.request);
    await awaitGate(gate.entered, provision);
    try {
      await f.storage.put(PRODUCTION_DATABASE_INTENT_STORAGE_KEY, {
        ...liveIntent(f.owner),
        state: "releasing",
      });
      await f.vault.completeProductionDatabaseRelease({
        ...f.owner,
        expectedProviderProjectId: "neon-project-42",
        expiresAtMs: Date.now() + 60_000,
      });
      expect(await f.vault.getProductionDatabaseIntent(f.owner)).toMatchObject({
        version: 1,
        state: "released",
        completionEvidence: { kind: "exact-provider-id-get-404" },
      });
    } finally {
      gate.resume();
    }
    await expect(provision).rejects.toThrow("production_database_intent_conflict");
    expect(await f.storage.get(CAPABILITY_KEY)).toBeUndefined();
  });

  const blockedHistories: Record<string, (owner: ProductionDatabaseIntentOwner) => unknown> = {
    "scoped releasing v1": (owner) => ({ ...liveIntent(owner), state: "releasing" }),
    "unscoped releasing v1": (owner) => ({
      ...liveIntent(owner),
      state: "releasing",
      scope: null,
      providerProjectId: null,
    }),
    "verified positive released v1": positiveRelease,
    "unmarked legacy released v1": (owner) => ({
      ...liveIntent(owner),
      state: "released",
      scope: null,
      providerProjectId: null,
    }),
    "sealed negative released v2": negativeRelease,
    "malformed releasing v2": (owner) => ({ ...negativeRelease(owner), state: "releasing" }),
    "malformed negative proof": (owner) => ({ ...negativeRelease(owner), completionEvidence: {} }),
    "stored null history": () => null,
    "malformed history": () => "untrusted-history",
    "wrong project history": (owner) => ({ ...liveIntent(owner), projectId: owner.projectId + 1 }),
    "noncanonical allocation history": (owner) => ({
      ...liveIntent(owner),
      allocationIdentity: "f".repeat(64),
    }),
  };

  it.each(Object.keys(blockedHistories))("preserves and fences %s", async (name) => {
    const f = await fixture();
    const history = blockedHistories[name]!(f.owner);
    await f.storage.put(PRODUCTION_DATABASE_INTENT_STORAGE_KEY, history);
    await expect(f.restart().provisionDatabase(f.request)).rejects.toThrow();
    expect(await f.storage.get(CAPABILITY_KEY)).toBeUndefined();
    expect(await f.storage.get(PRODUCTION_DATABASE_INTENT_STORAGE_KEY)).toEqual(history);
  });

  const blockedAllocations: Record<string, (owner: ProductionDatabaseIntentOwner) => unknown> = {
    "releasing allocation without an intent": releasingAllocation,
    "stored null allocation": () => null,
    "malformed allocation": () => ({ state: "allocated" }),
    "wrong project allocation": (owner) => ({
      ...releasingAllocation(owner),
      projectId: owner.projectId + 1,
    }),
    "noncanonical allocation identity": (owner) => ({
      ...releasingAllocation(owner),
      allocationIdentity: "f".repeat(64),
    }),
  };

  it.each(Object.keys(blockedAllocations))("preserves and fences %s", async (name) => {
    const f = await fixture();
    const allocation = blockedAllocations[name]!(f.owner);
    await f.storage.put(ALLOCATION_KEY, allocation);
    await expect(f.vault.provisionDatabase(f.request)).rejects.toThrow(
      "production_database_intent_conflict",
    );
    expect(await f.storage.get(CAPABILITY_KEY)).toBeUndefined();
    expect(await f.storage.get(ALLOCATION_KEY)).toEqual(allocation);
    expect(await f.storage.get(PRODUCTION_DATABASE_INTENT_STORAGE_KEY)).toBeUndefined();
  });

  it("allows ordinary provisioning without turning missing history into negative proof", async () => {
    const f = await fixture();
    await expect(f.vault.provisionDatabase(f.request)).resolves.toEqual({
      state: "provisioned",
      keyId: "v1",
    });
    expect(await f.storage.get(CAPABILITY_KEY)).toMatchObject({
      projectId: f.owner.projectId,
      envelope: { algorithm: "AES-256-GCM", keyId: "v1" },
    });
    expect(await f.storage.get(PRODUCTION_DATABASE_INTENT_STORAGE_KEY)).toBeUndefined();
    expect(await f.storage.get(ALLOCATION_KEY)).toBeUndefined();
  });

  it("preserves live provisioning and rotation in another project's vault", async () => {
    const retired = await fixture(42);
    await retired.vault.completeNeverDispatchedProductionDatabaseRelease({
      ...retired.owner,
      receipt: sealedReceipt(retired.owner),
    });
    const live = await fixture(43);
    const history = liveIntent(live.owner);
    await live.storage.put(PRODUCTION_DATABASE_INTENT_STORAGE_KEY, history);
    await expect(live.vault.provisionDatabase(live.request)).resolves.toMatchObject({
      state: "provisioned",
    });
    await expect(
      live.restart().provisionDatabase({ ...live.request, revision: "rotated-live-revision" }),
    ).resolves.toMatchObject({ state: "provisioned" });
    expect(await live.storage.get(CAPABILITY_KEY)).toMatchObject({
      projectId: 43,
      revision: "rotated-live-revision",
    });
    expect(await live.storage.get(PRODUCTION_DATABASE_INTENT_STORAGE_KEY)).toEqual(history);
    expect(await retired.storage.get(CAPABILITY_KEY)).toBeUndefined();
    expect(await retired.vault.getProductionDatabaseIntent(retired.owner)).toMatchObject({
      version: 2,
      state: "released",
    });
  });
});
