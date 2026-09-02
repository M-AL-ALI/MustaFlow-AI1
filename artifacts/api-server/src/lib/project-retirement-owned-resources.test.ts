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

describe("project retirement owned resources", () => {
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
