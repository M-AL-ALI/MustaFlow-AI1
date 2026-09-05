import { describe, expect, it } from "vitest";
import type { ProductionDatabaseAdmissionReceipt } from "@workspace/tenant-runtime-contracts";
import type { WorkerBindings } from "../src/bindings";
import { CapabilityVaultDurableObject } from "../src/capability-vault-durable-object";
import {
  PRODUCTION_DATABASE_INTENT_STORAGE_KEY,
  beginProductionDatabaseReleaseIntent,
  claimProductionDatabaseDispatchIntent,
  completeNeverDispatchedProductionDatabaseReleaseIntent,
  completeProductionDatabaseReleaseIntent,
  hasVerifiedProductionDatabaseRelease,
  observeProductionDatabaseProjectIntent,
  parseProductionDatabaseIntent,
  type ProductionDatabaseIntent,
} from "../src/production-database-intent";

const owner = { projectId: 42, allocationIdentity: "a".repeat(64) };
const nowMs = Date.parse("2026-09-03T00:00:00.000Z");
const scope = {
  providerOrganizationId: "org-production",
  regionId: "aws-us-east-2",
  historyRetentionSeconds: 604_800,
};
const receipt: ProductionDatabaseAdmissionReceipt = {
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
const otherUuid = "44444444-4444-4444-8444-444444444444";
const allocationKey = "allocation:production:neon-postgres";
const capabilityKey = "capability:neon-postgres:database";

class TransactionStorage {
  constructor(public values = new Map<string, unknown>()) {}

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  serialized(): string {
    return JSON.stringify([...this.values.entries()]);
  }
}

class AtomicMemoryStorage extends TransactionStorage {
  failNextCommit = false;
  private tail: Promise<void> = Promise.resolve();

  transaction<T>(callback: (transaction: TransactionStorage) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const transaction = new TransactionStorage(structuredClone(this.values));
      const value = await callback(transaction);
      if (this.failNextCommit) {
        this.failNextCommit = false;
        throw new Error("synthetic transaction commit failure");
      }
      this.values = transaction.values;
      return value;
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function fixture() {
  const storage = new AtomicMemoryStorage();
  const state = { storage } as unknown as DurableObjectState;
  const env = {} as WorkerBindings;
  const restart = () => new CapabilityVaultDurableObject(state, env);
  return { storage, vault: restart(), restart };
}

const known = observeProductionDatabaseProjectIntent(
  null,
  owner,
  scope,
  "owned-provider-project",
  nowMs,
);
const dispatched = claimProductionDatabaseDispatchIntent(null, owner, scope, nowMs);
const releasing = beginProductionDatabaseReleaseIntent(known, owner, null, nowMs);
const exactReleased = completeProductionDatabaseReleaseIntent(
  releasing,
  owner,
  "owned-provider-project",
  nowMs,
);
const unmarkedReleased: ProductionDatabaseIntent = {
  version: 1,
  ...owner,
  state: "released",
  scope: null,
  providerProjectId: null,
  createdAt: new Date(nowMs).toISOString(),
  updatedAt: new Date(nowMs).toISOString(),
};

describe("production database admission state", () => {
  it("marks negative completion with version 2 and only the necessary receipt evidence", () => {
    const negative = completeNeverDispatchedProductionDatabaseReleaseIntent(
      null,
      owner,
      receipt,
      nowMs,
    );
    expect(negative).toEqual({
      version: 2,
      ...owner,
      state: "released",
      scope: null,
      providerProjectId: null,
      createdAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
      completionEvidence: {
        version: 1,
        kind: "sealed-birth-no-dispatch",
        registrationEpoch: receipt.registrationEpoch,
        birthToken: receipt.birthToken,
        receiptId: receipt.receiptId,
        verifiedAt: new Date(nowMs).toISOString(),
      },
    });
    expect(parseProductionDatabaseIntent(negative, owner)).toEqual(negative);
    expect(hasVerifiedProductionDatabaseRelease(negative)).toBe(true);
    expect(hasVerifiedProductionDatabaseRelease(exactReleased)).toBe(true);
    expect(hasVerifiedProductionDatabaseRelease(unmarkedReleased)).toBe(false);
    expect(hasVerifiedProductionDatabaseRelease(null)).toBe(false);
  });

  it("rejects incomplete, extra-field, and incorrectly versioned negative markers", () => {
    const negative = completeNeverDispatchedProductionDatabaseReleaseIntent(
      null,
      owner,
      receipt,
      nowMs,
    );
    const invalid = [
      { ...negative, version: 1 },
      { ...negative, completionEvidence: undefined },
      {
        ...negative,
        completionEvidence: {
          version: 1,
          kind: "sealed-birth-no-dispatch",
          verifiedAt: new Date(nowMs).toISOString(),
        },
      },
      {
        ...negative,
        completionEvidence: { ...negative.completionEvidence, extra: true },
      },
      {
        ...negative,
        completionEvidence: { ...negative.completionEvidence, receiptId: "not-a-uuid" },
      },
    ];
    for (const candidate of invalid) {
      expect(hasVerifiedProductionDatabaseRelease(candidate as ProductionDatabaseIntent)).toBe(
        false,
      );
      expect(() => parseProductionDatabaseIntent(candidate, owner)).toThrow(
        "production_database_intent_conflict",
      );
    }
  });

  it("preserves exact-ID missing-proof and mismatched-ID semantics", () => {
    expect(() =>
      completeProductionDatabaseReleaseIntent(releasing, owner, undefined, nowMs),
    ).toThrow("production_database_allocation_uncertain");
    expect(() =>
      completeProductionDatabaseReleaseIntent(releasing, owner, "different-provider", nowMs),
    ).toThrow("production_database_intent_conflict");
    expect(() =>
      completeProductionDatabaseReleaseIntent(unmarkedReleased, owner, undefined, nowMs),
    ).toThrow("production_database_allocation_uncertain");
    expect(
      completeProductionDatabaseReleaseIntent(releasing, owner, "owned-provider-project", nowMs),
    ).toEqual(exactReleased);
  });

  it("survives restart, replays identically, and blocks a late claim or observation", async () => {
    const f = fixture();
    await expect(
      f.vault.completeNeverDispatchedProductionDatabaseRelease({ ...owner, receipt }),
    ).resolves.toBe("released");
    const before = f.storage.serialized();
    const restarted = f.restart();
    await expect(
      restarted.completeNeverDispatchedProductionDatabaseRelease({ ...owner, receipt }),
    ).resolves.toBe("replayed");
    await expect(
      restarted.claimProductionDatabaseDispatch({
        ...owner,
        scope,
        expiresAtMs: Date.now() + 60_000,
      }),
    ).rejects.toThrow("production_database_release_in_progress");
    await expect(
      restarted.recordProductionDatabaseProject({
        ...owner,
        scope,
        providerProjectId: "late-provider-project",
      }),
    ).rejects.toThrow("production_database_release_in_progress");
    expect(f.storage.serialized()).toBe(before);
    expect([...f.storage.values.keys()]).toEqual([PRODUCTION_DATABASE_INTENT_STORAGE_KEY]);
  });

  it("rolls back a failed negative commit and permits a fresh retry after restart", async () => {
    const f = fixture();
    f.storage.failNextCommit = true;
    await expect(
      f.vault.completeNeverDispatchedProductionDatabaseRelease({ ...owner, receipt }),
    ).rejects.toThrow("synthetic transaction commit failure");
    expect(f.storage.values.size).toBe(0);
    const restarted = f.restart();
    await expect(restarted.getProductionDatabaseIntent(owner)).resolves.toBeNull();
    await expect(
      restarted.completeNeverDispatchedProductionDatabaseRelease({ ...owner, receipt }),
    ).resolves.toBe("released");
  });

  it.each(["negative-first", "claim-first"] as const)(
    "serializes a concurrent negative completion and dispatch claim: %s",
    async (order) => {
      const f = fixture();
      const seal = () =>
        f.vault.completeNeverDispatchedProductionDatabaseRelease({ ...owner, receipt });
      const claim = () =>
        f.vault.claimProductionDatabaseDispatch({
          ...owner,
          scope,
          expiresAtMs: Date.now() + 60_000,
        });
      const outcomes = await Promise.allSettled(
        order === "negative-first" ? [seal(), claim()] : [claim(), seal()],
      );
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
      const intent = await f.vault.getProductionDatabaseIntent(owner);
      expect(intent?.state).toBe(order === "negative-first" ? "released" : "dispatched");
      expect(hasVerifiedProductionDatabaseRelease(intent)).toBe(order === "negative-first");
    },
  );

  it.each([
    {
      label: "allocation",
      key: allocationKey,
      value: {
        format: "nabuflow.production-database-allocation/v1",
        ...owner,
        ...scope,
        provider: "neon-postgres",
        providerProjectId: "owned-provider-project",
        revision: "production-database-a",
        state: "ready",
        createdAt: new Date(nowMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
      },
    },
    {
      label: "capability",
      key: capabilityKey,
      value: { projectId: owner.projectId, revision: "retain-existing-capability" },
    },
    { label: "uncertain dispatch", key: PRODUCTION_DATABASE_INTENT_STORAGE_KEY, value: dispatched },
    { label: "known provider", key: PRODUCTION_DATABASE_INTENT_STORAGE_KEY, value: known },
    { label: "releasing", key: PRODUCTION_DATABASE_INTENT_STORAGE_KEY, value: releasing },
    {
      label: "unscoped legacy release",
      key: PRODUCTION_DATABASE_INTENT_STORAGE_KEY,
      value: beginProductionDatabaseReleaseIntent(null, owner, null, nowMs),
    },
    {
      label: "unmarked legacy tombstone",
      key: PRODUCTION_DATABASE_INTENT_STORAGE_KEY,
      value: unmarkedReleased,
    },
    {
      label: "exact-ID release receipt",
      key: PRODUCTION_DATABASE_INTENT_STORAGE_KEY,
      value: exactReleased,
    },
  ])(
    "retains contradictory $label evidence without negative completion",
    async ({ key, value }) => {
      const f = fixture();
      await f.storage.put(key, value);
      const before = f.storage.serialized();
      await expect(
        f.vault.completeNeverDispatchedProductionDatabaseRelease({ ...owner, receipt }),
      ).rejects.toThrow("production_database_intent_conflict");
      expect(f.storage.serialized()).toBe(before);
    },
  );

  const missingBirth: Record<string, unknown> = { ...receipt };
  delete missingBirth.birthRegistered;

  it.each([
    { label: "missing receipt", value: undefined },
    { label: "missing birth field", value: missingBirth },
    { label: "legacy birth", value: { ...receipt, birthRegistered: false } },
    { label: "authorized assertion", value: { ...receipt, assertion: "authorized" } },
    { label: "wrong project", value: { ...receipt, projectId: 43 } },
    { label: "wrong allocation", value: { ...receipt, allocationIdentity: "b".repeat(64) } },
    { label: "wrong format", value: { ...receipt, format: "other-format" } },
    { label: "wrong issuer", value: { ...receipt, issuer: "other-api" } },
    { label: "wrong audience", value: { ...receipt, audience: "staging" } },
    { label: "malformed epoch", value: { ...receipt, registrationEpoch: "not-a-uuid" } },
    { label: "malformed birth", value: { ...receipt, birthToken: "not-a-uuid" } },
    { label: "malformed seal", value: { ...receipt, receiptId: "not-a-uuid" } },
    { label: "extra field", value: { ...receipt, extra: true } },
  ])("cannot initialize negative proof from $label", async ({ value }) => {
    const f = fixture();
    await expect(
      f.vault.completeNeverDispatchedProductionDatabaseRelease({
        ...owner,
        receipt: value as ProductionDatabaseAdmissionReceipt,
      }),
    ).rejects.toThrow();
    expect(f.storage.values.size).toBe(0);
  });

  it.each(["registrationEpoch", "birthToken", "receiptId"] as const)(
    "rejects a changed %s on replay without replacing the first receipt",
    async (field) => {
      const f = fixture();
      await f.vault.completeNeverDispatchedProductionDatabaseRelease({ ...owner, receipt });
      const before = f.storage.serialized();
      await expect(
        f.restart().completeNeverDispatchedProductionDatabaseRelease({
          ...owner,
          receipt: { ...receipt, [field]: otherUuid },
        }),
      ).rejects.toThrow("production_database_intent_conflict");
      expect(f.storage.serialized()).toBe(before);
    },
  );

  it("replays through ordinary completion without deleting later capability evidence", async () => {
    const f = fixture();
    await f.vault.completeNeverDispatchedProductionDatabaseRelease({ ...owner, receipt });
    const negativeOnly = f.storage.serialized();
    await expect(f.vault.completeProductionDatabaseRelease(owner)).resolves.toBe("not_found");
    expect(f.storage.serialized()).toBe(negativeOnly);
    await expect(
      f.vault.completeProductionDatabaseRelease({
        ...owner,
        expectedProviderProjectId: "unexpected-provider-project",
      }),
    ).resolves.toBe("conflict");
    await f.storage.put(capabilityKey, { projectId: owner.projectId, revision: "retain-evidence" });
    const withCapability = f.storage.serialized();
    await expect(
      f.vault.completeNeverDispatchedProductionDatabaseRelease({ ...owner, receipt }),
    ).rejects.toThrow("production_database_intent_conflict");
    await expect(f.vault.completeProductionDatabaseRelease(owner)).resolves.toBe("conflict");
    expect(f.storage.serialized()).toBe(withCapability);
  });
});
