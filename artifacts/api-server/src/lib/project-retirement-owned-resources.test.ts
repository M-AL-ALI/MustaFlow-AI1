import { describe, expect, it, vi } from "vitest";
import {
  classifyManagedAddonRetirement,
  preserveProjectSqliteForRetirement,
  retireProjectManagedAddonBindings,
  type ProjectManagedAddonBinding,
} from "./project-retirement-owned-resources";

function addon(overrides: Partial<ProjectManagedAddonBinding> = {}): ProjectManagedAddonBinding {
  return {
    id: 1,
    kind: "redis_kv",
    status: "active",
    externalId: "binding-1",
    connectionInfo: { provider: "upstash" },
    injectedEnvKeys: ["REDIS_URL", "REDIS_TOKEN"],
    removedAt: null,
    ...overrides,
  };
}

function sqlitePredecessorFixture(generation = 1) {
  type Dependencies = NonNullable<Parameters<typeof preserveProjectSqliteForRetirement>[1]>;
  type Operation = NonNullable<
    Awaited<ReturnType<NonNullable<Dependencies["readRetirementOperation"]>>>
  >;
  const deletedAt = new Date("2026-09-01T00:00:00Z");
  const createdAt = new Date("2026-09-01T01:00:00Z");
  const dump = "BEGIN; CREATE TABLE restored(id); COMMIT;";
  const snapshot = {
    id: 91,
    projectId: 49,
    label: "trash-recovery:op-0",
    provider: "sqlite",
    dumpContent: dump as string | null,
    objectKey: null as string | null,
    isPartial: false,
    sizeBytes: Buffer.byteLength(dump),
  };
  const operations = new Map<string, Operation>();
  for (let current = 0; current <= generation; current += 1) {
    operations.set(`op-${current}`, {
      id: `op-${current}`,
      projectId: 49,
      state: current === generation ? "running" : "completed",
      createdAt,
      completedAt: current === generation ? null : createdAt,
      progress: {
        ...(current > 0
          ? { reconciliation: { generation: current, parentOperationId: `op-${current - 1}` } }
          : {}),
        ...(current === 0
          ? {
              sqliteRecovery: {
                state: "preserved",
                snapshotId: 91,
                sizeBytes: snapshot.sizeBytes,
                storage: "inline",
                failureCode: null,
              },
            }
          : {}),
      },
    });
  }
  const dependencies = {
    readProject: vi.fn(async () => ({
      dbProvider: "sqlite",
      dbStatus: "ready",
      containerId: null,
      deletedAt,
    })),
    readSnapshots: vi.fn(async (projectId: number, label: string, snapshotId?: number) =>
      snapshot.projectId === projectId &&
      snapshot.label === label &&
      (snapshotId === undefined || snapshot.id === snapshotId)
        ? [snapshot]
        : [],
    ),
    readRetirementOperation: vi.fn(
      async (_projectId: number, operationId: string) => operations.get(operationId) ?? null,
    ),
    exec: vi.fn(),
    upload: vi.fn(),
    objectExists: vi.fn(async () => true),
    insertSnapshot: vi.fn(),
    deleteObject: vi.fn(),
  } satisfies Dependencies;
  return {
    dependencies,
    snapshot,
    operations,
    input: { projectId: 49, operationId: `op-${generation}` },
  };
}

describe("project retirement owned resources", () => {
  it("reproduces current-label-only failure and reuses a revalidated server-recorded parent snapshot", async () => {
    const fixture = sqlitePredecessorFixture();
    const { readRetirementOperation: _lineage, ...oldLookup } = fixture.dependencies;
    expect(await preserveProjectSqliteForRetirement(fixture.input, oldLookup)).toEqual({
      ok: false,
      code: "project_retirement_sqlite_snapshot_unverified",
      retryable: true,
    });
    const recovered = await preserveProjectSqliteForRetirement(fixture.input, fixture.dependencies);
    expect(recovered).toMatchObject({
      ok: true,
      receipt: { state: "preserved", snapshotId: 91, storage: "inline" },
    });
    expect(fixture.dependencies.readSnapshots).toHaveBeenCalledWith(49, "trash-recovery:op-0", 91);
    expect(fixture.dependencies.exec).not.toHaveBeenCalled();
    expect(fixture.dependencies.upload).not.toHaveBeenCalled();
    expect(fixture.dependencies.insertSnapshot).not.toHaveBeenCalled();
  });

  it("follows at most four same-project predecessors through the approved repair generation", async () => {
    const fixture = sqlitePredecessorFixture(4);
    expect(
      await preserveProjectSqliteForRetirement(fixture.input, fixture.dependencies),
    ).toMatchObject({ ok: true });
    expect(fixture.dependencies.readRetirementOperation.mock.calls).toEqual([
      [49, "op-4"],
      [49, "op-3"],
      [49, "op-2"],
      [49, "op-1"],
      [49, "op-0"],
    ]);
    expect(fixture.dependencies.exec).not.toHaveBeenCalled();
  });

  it.each([
    "missing_parent",
    "cross_project",
    "cross_cycle",
    "restored_parent",
    "cycle",
    "generation_gap",
    "nonterminal_parent",
    "missing_server_receipt",
    "active_project",
    "over_limit",
  ])("never reuses a snapshot across invalid lineage: %s", async (variant) => {
    const fixture = sqlitePredecessorFixture(variant === "over_limit" ? 5 : 1);
    const parent = fixture.operations.get("op-0")!;
    if (variant === "missing_parent") fixture.operations.delete("op-0");
    if (variant === "cross_project") parent.projectId = 50;
    if (variant === "cross_cycle") parent.createdAt = new Date("2026-08-01T00:00:00Z");
    if (variant === "restored_parent")
      Object.assign(parent.progress as object, { restore: { state: "restored" } });
    if (variant === "cycle")
      fixture.operations.get("op-1")!.progress = {
        reconciliation: { generation: 1, parentOperationId: "op-1" },
      };
    if (variant === "generation_gap")
      Object.assign(parent.progress as object, { reconciliation: { generation: 2 } });
    if (variant === "nonterminal_parent") parent.completedAt = null;
    if (variant === "missing_server_receipt") parent.progress = {};
    if (variant === "active_project")
      fixture.dependencies.readProject.mockResolvedValueOnce({
        dbProvider: "sqlite",
        dbStatus: "ready",
        containerId: null,
        deletedAt: null as unknown as Date,
      });
    expect(
      await preserveProjectSqliteForRetirement(fixture.input, fixture.dependencies),
    ).toMatchObject({ ok: false });
    expect(fixture.dependencies.readRetirementOperation.mock.calls.length).toBeLessThanOrEqual(5);
    expect(fixture.dependencies.exec).not.toHaveBeenCalled();
    expect(fixture.dependencies.insertSnapshot).not.toHaveBeenCalled();
  });

  it.each(["partial", "wrong_id", "wrong_size", "wrong_project", "wrong_label", "missing_object"])(
    "requires current snapshot evidence even with valid lineage: %s",
    async (variant) => {
      const fixture = sqlitePredecessorFixture();
      if (variant === "partial") fixture.snapshot.isPartial = true;
      if (variant === "wrong_id") fixture.snapshot.id = 92;
      if (variant === "wrong_size") fixture.snapshot.sizeBytes += 1;
      if (variant === "wrong_project") fixture.snapshot.projectId = 50;
      if (variant === "wrong_label") fixture.snapshot.label = "user-backup";
      if (variant === "missing_object") {
        fixture.snapshot.dumpContent = null;
        fixture.snapshot.objectKey = "snapshot-object";
        (
          fixture.operations.get("op-0")!.progress as { sqliteRecovery: { storage: string } }
        ).sqliteRecovery.storage = "object";
        fixture.dependencies.objectExists.mockResolvedValue(false);
      }
      expect(
        await preserveProjectSqliteForRetirement(fixture.input, fixture.dependencies),
      ).toMatchObject({ ok: false });
      expect(fixture.dependencies.deleteObject).not.toHaveBeenCalled();
      expect(fixture.dependencies.insertSnapshot).not.toHaveBeenCalled();
    },
  );

  it("revalidates object presence before reusing a predecessor object snapshot", async () => {
    const fixture = sqlitePredecessorFixture();
    fixture.snapshot.dumpContent = null;
    fixture.snapshot.objectKey = "verified-parent-object";
    (
      fixture.operations.get("op-0")!.progress as { sqliteRecovery: { storage: string } }
    ).sqliteRecovery.storage = "object";
    expect(
      await preserveProjectSqliteForRetirement(fixture.input, fixture.dependencies),
    ).toMatchObject({
      ok: true,
      receipt: { state: "preserved", snapshotId: 91, storage: "object" },
    });
    expect(fixture.dependencies.objectExists).toHaveBeenCalledWith("verified-parent-object");
    expect(fixture.dependencies.deleteObject).not.toHaveBeenCalled();
  });
  it("detaches every known binding, removes only its project secrets, and proves absence", async () => {
    let rows = [
      addon(),
      addon({
        id: 2,
        kind: "object_storage",
        connectionInfo: { provider: "cloudflare-r2" },
        injectedEnvKeys: ["OBJECT_STORAGE_BUCKET"],
      }),
    ];
    const secrets = new Set(["REDIS_URL", "REDIS_TOKEN", "OBJECT_STORAGE_BUCKET", "KEEP_ME"]);
    const result = await retireProjectManagedAddonBindings(51, {
      listForUpdate: async () => rows,
      detach: async (_projectId, ids) => {
        rows = rows.map((row) =>
          ids.includes(row.id)
            ? {
                ...row,
                status: "removed",
                externalId: null,
                connectionInfo: null,
                injectedEnvKeys: [],
                removedAt: new Date("2026-09-01T00:00:00.000Z"),
              }
            : row,
        );
      },
      deleteSecrets: async (_projectId, names) => {
        let count = 0;
        for (const name of names) if (secrets.delete(name)) count += 1;
        return count;
      },
      listSecrets: async (_projectId, names) => names.filter((name) => secrets.has(name)),
    });

    expect(result).toEqual({
      ok: true,
      receipt: {
        state: "verified_detached",
        discoveredCount: 2,
        detachedCount: 2,
        secretsRemoved: 3,
        bindingsRemaining: 0,
        failureCode: null,
      },
    });
    expect(secrets).toEqual(new Set(["KEEP_ME"]));
    expect(rows.every((row) => row.status === "removed" && row.externalId === null)).toBe(true);
  });

  it("is idempotent when the same retired add-on set is replayed", async () => {
    const rows = [
      addon({
        status: "removed",
        externalId: null,
        connectionInfo: null,
        injectedEnvKeys: [],
        removedAt: new Date("2026-09-01T00:00:00.000Z"),
      }),
    ];
    const detach = vi.fn(async () => undefined);
    const result = await retireProjectManagedAddonBindings(51, {
      listForUpdate: async () => rows,
      detach,
      deleteSecrets: async () => 0,
      listSecrets: async () => [],
    });
    expect(result).toMatchObject({
      ok: true,
      receipt: { discoveredCount: 1, detachedCount: 1, secretsRemoved: 0 },
    });
    expect(detach).toHaveBeenCalledWith(51, [1]);
  });

  it("fails closed before mutation for an unregistered provider family", async () => {
    expect(
      classifyManagedAddonRetirement([addon({ connectionInfo: { provider: "future-provider" } })]),
    ).toEqual({
      allowed: false,
      code: "project_retirement_managed_addon_unverified",
    });
    const detach = vi.fn(async () => undefined);
    const result = await retireProjectManagedAddonBindings(51, {
      listForUpdate: async () => [addon({ connectionInfo: { provider: "future-provider" } })],
      detach,
      deleteSecrets: async () => 0,
      listSecrets: async () => [],
    });
    expect(result).toEqual({
      ok: false,
      code: "project_retirement_managed_addon_release_unverified",
      retryable: false,
    });
    expect(detach).not.toHaveBeenCalled();
  });

  it("does not earn success unless provider bindings and injected secrets are absent", async () => {
    const result = await retireProjectManagedAddonBindings(51, {
      listForUpdate: async () => [addon()],
      detach: async () => undefined,
      deleteSecrets: async () => 0,
      listSecrets: async () => ["REDIS_URL"],
    });
    expect(result).toEqual({
      ok: false,
      code: "project_retirement_managed_addon_release_unverified",
      retryable: true,
    });
  });

  it("captures SQLite before destruction and reuses the verified receipt on retry", async () => {
    const snapshots: Array<{
      id: number;
      provider: string;
      dumpContent: string | null;
      objectKey: string | null;
      isPartial: boolean;
      sizeBytes: number;
    }> = [];
    const exec = vi.fn(async () => ({ ok: true, output: "BEGIN;\nCREATE TABLE t(id);\nCOMMIT;" }));
    const dependencies = {
      readProject: async () => ({ dbProvider: "sqlite", dbStatus: "connected", containerId: "r1" }),
      readSnapshots: async () => snapshots,
      exec,
      upload: async () => null,
      objectExists: async () => false,
      insertSnapshot: async (input: {
        dumpContent: string | null;
        objectKey: string | null;
        sizeBytes: number;
      }) => {
        const row = {
          id: 91,
          provider: "sqlite",
          dumpContent: input.dumpContent,
          objectKey: input.objectKey,
          isPartial: false,
          sizeBytes: input.sizeBytes,
        };
        snapshots.push(row);
        return row;
      },
      deleteObject: async () => true,
    };
    const first = await preserveProjectSqliteForRetirement(
      { projectId: 51, operationId: "op-1" },
      dependencies,
    );
    const replay = await preserveProjectSqliteForRetirement(
      { projectId: 51, operationId: "op-1" },
      dependencies,
    );
    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      ok: true,
      receipt: { state: "preserved", snapshotId: 91, storage: "inline" },
    });
    expect(exec).toHaveBeenCalledOnce();
  });

  it("distinguishes a proven absent SQLite file from an unavailable runtime", async () => {
    const base = {
      readProject: async () => ({ dbProvider: "sqlite", dbStatus: "connected", containerId: "r1" }),
      readSnapshots: async () => [],
      upload: async () => null,
      objectExists: async () => false,
      insertSnapshot: vi.fn(),
      deleteObject: async () => true,
    };
    await expect(
      preserveProjectSqliteForRetirement(
        { projectId: 51, operationId: "op-2" },
        { ...base, exec: async () => ({ ok: true, output: "__NABUFLOW_SQLITE_ABSENT__" }) },
      ),
    ).resolves.toMatchObject({ ok: true, receipt: { state: "not_present" } });
    await expect(
      preserveProjectSqliteForRetirement(
        { projectId: 51, operationId: "op-3" },
        { ...base, exec: async () => ({ ok: false, output: "" }) },
      ),
    ).resolves.toEqual({
      ok: false,
      code: "project_retirement_sqlite_snapshot_failed",
      retryable: true,
    });
  });

  it("requires object-store presence and removes an orphan when insertion cannot earn evidence", async () => {
    const deleteObject = vi.fn(async () => true);
    const result = await preserveProjectSqliteForRetirement(
      { projectId: 51, operationId: "op-4" },
      {
        readProject: async () => ({
          dbProvider: "sqlite",
          dbStatus: "connected",
          containerId: "r1",
        }),
        readSnapshots: async () => [],
        exec: async () => ({ ok: true, output: "BEGIN; COMMIT;" }),
        upload: async () => "snapshot-object",
        objectExists: async () => false,
        insertSnapshot: async (input) => ({
          id: 92,
          provider: "sqlite",
          dumpContent: input.dumpContent,
          objectKey: input.objectKey,
          isPartial: false,
          sizeBytes: input.sizeBytes,
        }),
        deleteObject,
      },
    );
    expect(result).toEqual({
      ok: false,
      code: "project_retirement_sqlite_snapshot_unverified",
      retryable: true,
    });
    expect(deleteObject).toHaveBeenCalledWith("snapshot-object");
  });
});
