import { and, eq, inArray, sql } from "drizzle-orm";
import { deleteSnapshotBlob, snapshotBlobExists, uploadSnapshotBlob } from "./snapshot-storage";

export type ProjectManagedAddonRetirementReceipt = {
  state: "verified_detached";
  discoveredCount: number;
  detachedCount: number;
  secretsRemoved: number;
  bindingsRemaining: 0;
  failureCode: null;
};

export type ProjectSqliteRetirementReceipt =
  | {
      state: "not_applicable" | "not_present";
      snapshotId: null;
      sizeBytes: 0;
      storage: null;
      failureCode: null;
    }
  | {
      state: "preserved";
      snapshotId: number;
      sizeBytes: number;
      storage: "inline" | "object";
      failureCode: null;
    };

export type ProjectRetirementOwnedResourceFailure = {
  ok: false;
  code:
    | "project_retirement_managed_addon_release_failed"
    | "project_retirement_managed_addon_release_unverified"
    | "project_retirement_sqlite_snapshot_failed"
    | "project_retirement_sqlite_snapshot_unverified";
  retryable: boolean;
};

export type ProjectManagedAddonRetirementResult =
  | { ok: true; receipt: ProjectManagedAddonRetirementReceipt }
  | ProjectRetirementOwnedResourceFailure;

export type ProjectSqliteRetirementResult =
  | { ok: true; receipt: ProjectSqliteRetirementReceipt }
  | ProjectRetirementOwnedResourceFailure;

export type ProjectManagedAddonBinding = {
  id: number;
  kind: string;
  status: string;
  externalId: string | null;
  connectionInfo: unknown;
  injectedEnvKeys: unknown;
  removedAt: Date | null;
};

type ManagedAddonRetirementAdapter = {
  listForUpdate(projectId: number): Promise<ProjectManagedAddonBinding[]>;
  detach(projectId: number, addonIds: number[]): Promise<void>;
  deleteSecrets(projectId: number, names: string[]): Promise<number>;
  listSecrets(projectId: number, names: string[]): Promise<string[]>;
};

const BINDING_ONLY_ADDON_PROVIDERS: Readonly<Record<string, ReadonlySet<string>>> = {
  redis_kv: new Set(["simulated", "upstash"]),
  vector_db: new Set(["pgvector"]),
  object_storage: new Set(["simulated", "cloudflare-r2"]),
};

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;

function bindingProvider(connectionInfo: unknown): string | null {
  if (
    typeof connectionInfo !== "object" ||
    connectionInfo === null ||
    !("provider" in connectionInfo) ||
    typeof connectionInfo.provider !== "string"
  ) {
    return null;
  }
  return connectionInfo.provider;
}

function injectedSecretNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const names = value.filter((entry): entry is string => typeof entry === "string");
  if (names.length !== value.length || names.some((name) => !SECRET_NAME.test(name))) return null;
  return [...new Set(names)].sort();
}

function hasManagedAddonBinding(row: ProjectManagedAddonBinding): boolean {
  const names = injectedSecretNames(row.injectedEnvKeys);
  return (
    row.status !== "removed" ||
    row.removedAt === null ||
    row.externalId !== null ||
    row.connectionInfo !== null ||
    names === null ||
    names.length > 0
  );
}

/**
 * Only providers created by the current binding-only implementation may be
 * detached without a provider delete. An unknown future provider fails closed
 * until it registers an explicit release-and-absence handler.
 */
export function classifyManagedAddonRetirement(
  rows: readonly ProjectManagedAddonBinding[],
):
  | { allowed: true; secretNames: string[] }
  | { allowed: false; code: "project_retirement_managed_addon_unverified" } {
  const secretNames = new Set<string>();
  for (const row of rows) {
    if (!hasManagedAddonBinding(row)) continue;
    const names = injectedSecretNames(row.injectedEnvKeys);
    const provider = bindingProvider(row.connectionInfo);
    const providers = BINDING_ONLY_ADDON_PROVIDERS[row.kind];
    if (names === null || !providers?.has(provider ?? "")) {
      return { allowed: false, code: "project_retirement_managed_addon_unverified" };
    }
    for (const name of names) secretNames.add(name);
  }
  return { allowed: true, secretNames: [...secretNames].sort() };
}

async function retireManagedAddonsWithAdapter(
  projectId: number,
  adapter: ManagedAddonRetirementAdapter,
): Promise<ProjectManagedAddonRetirementResult> {
  const before = await adapter.listForUpdate(projectId);
  const classification = classifyManagedAddonRetirement(before);
  if (!classification.allowed) {
    return {
      ok: false,
      code: "project_retirement_managed_addon_release_unverified",
      retryable: false,
    };
  }

  await adapter.detach(
    projectId,
    before.map((row) => row.id),
  );
  const secretsRemoved = await adapter.deleteSecrets(projectId, classification.secretNames);
  const [after, remainingSecrets] = await Promise.all([
    adapter.listForUpdate(projectId),
    adapter.listSecrets(projectId, classification.secretNames),
  ]);
  const bindingsRemaining = after.filter(hasManagedAddonBinding).length;
  if (bindingsRemaining !== 0 || remainingSecrets.length !== 0 || after.length !== before.length) {
    return {
      ok: false,
      code: "project_retirement_managed_addon_release_unverified",
      retryable: true,
    };
  }
  return {
    ok: true,
    receipt: {
      state: "verified_detached",
      discoveredCount: before.length,
      detachedCount: after.length,
      secretsRemoved,
      bindingsRemaining: 0,
      failureCode: null,
    },
  };
}

export async function retireProjectManagedAddonBindings(
  projectId: number,
  adapter?: ManagedAddonRetirementAdapter,
): Promise<ProjectManagedAddonRetirementResult> {
  try {
    if (adapter) return await retireManagedAddonsWithAdapter(projectId, adapter);
    const { db, managedAddonsTable, secretsTable } = await import("@workspace/db");
    return await db.transaction(async (tx) =>
      retireManagedAddonsWithAdapter(projectId, {
        listForUpdate: async (scopedProjectId) =>
          tx
            .select({
              id: managedAddonsTable.id,
              kind: managedAddonsTable.kind,
              status: managedAddonsTable.status,
              externalId: managedAddonsTable.externalId,
              connectionInfo: managedAddonsTable.connectionInfo,
              injectedEnvKeys: managedAddonsTable.injectedEnvKeys,
              removedAt: managedAddonsTable.removedAt,
            })
            .from(managedAddonsTable)
            .where(eq(managedAddonsTable.projectId, scopedProjectId))
            .orderBy(managedAddonsTable.id)
            .for("update"),
        detach: async (scopedProjectId, addonIds) => {
          if (addonIds.length === 0) return;
          await tx
            .update(managedAddonsTable)
            .set({
              status: "removed",
              externalId: null,
              connectionInfo: null,
              injectedEnvKeys: [],
              removedAt: sql`COALESCE(${managedAddonsTable.removedAt}, now())`,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(managedAddonsTable.projectId, scopedProjectId),
                inArray(managedAddonsTable.id, addonIds),
              ),
            );
        },
        deleteSecrets: async (scopedProjectId, names) => {
          if (names.length === 0) return 0;
          const removed = await tx
            .delete(secretsTable)
            .where(
              and(eq(secretsTable.projectId, scopedProjectId), inArray(secretsTable.name, names)),
            )
            .returning({ id: secretsTable.id });
          return removed.length;
        },
        listSecrets: async (scopedProjectId, names) => {
          if (names.length === 0) return [];
          const remaining = await tx
            .select({ name: secretsTable.name })
            .from(secretsTable)
            .where(
              and(eq(secretsTable.projectId, scopedProjectId), inArray(secretsTable.name, names)),
            );
          return remaining.map((row) => row.name);
        },
      }),
    );
  } catch {
    return {
      ok: false,
      code: "project_retirement_managed_addon_release_failed",
      retryable: true,
    };
  }
}

type SqliteProjectFacts = {
  dbProvider: string;
  dbStatus: string;
  containerId: string | null;
};

type SqliteSnapshotRow = {
  id: number;
  provider: string;
  dumpContent: string | null;
  objectKey: string | null;
  isPartial: boolean;
  sizeBytes: number;
};

type SqliteRetirementDependencies = {
  readProject(projectId: number): Promise<SqliteProjectFacts | null>;
  readSnapshots(projectId: number, label: string): Promise<SqliteSnapshotRow[]>;
  exec(runtimeId: string, projectId: number): Promise<{ ok: boolean; output: string }>;
  upload(projectId: number, content: string): Promise<string | null>;
  objectExists(objectKey: string): Promise<boolean>;
  insertSnapshot(input: {
    projectId: number;
    label: string;
    dumpContent: string | null;
    objectKey: string | null;
    sizeBytes: number;
  }): Promise<SqliteSnapshotRow>;
  deleteObject(objectKey: string): Promise<boolean>;
};

const SQLITE_ABSENT_MARKER = "__NABUFLOW_SQLITE_ABSENT__";

async function verifiedSqliteReceipt(
  snapshot: SqliteSnapshotRow,
  dependencies: SqliteRetirementDependencies,
): Promise<ProjectSqliteRetirementReceipt | null> {
  if (
    snapshot.provider !== "sqlite" ||
    snapshot.isPartial ||
    !Number.isInteger(snapshot.sizeBytes) ||
    snapshot.sizeBytes <= 0
  ) {
    return null;
  }
  if (snapshot.objectKey !== null) {
    if (snapshot.dumpContent !== null || !(await dependencies.objectExists(snapshot.objectKey))) {
      return null;
    }
    return {
      state: "preserved",
      snapshotId: snapshot.id,
      sizeBytes: snapshot.sizeBytes,
      storage: "object",
      failureCode: null,
    };
  }
  if (
    snapshot.dumpContent === null ||
    Buffer.byteLength(snapshot.dumpContent, "utf8") !== snapshot.sizeBytes
  ) {
    return null;
  }
  return {
    state: "preserved",
    snapshotId: snapshot.id,
    sizeBytes: snapshot.sizeBytes,
    storage: "inline",
    failureCode: null,
  };
}

const defaultSqliteRetirementDependencies: SqliteRetirementDependencies = {
  readProject: async (projectId) => {
    const { db, projectsTable } = await import("@workspace/db");
    const [project] = await db
      .select({
        dbProvider: projectsTable.dbProvider,
        dbStatus: projectsTable.dbStatus,
        containerId: projectsTable.containerId,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId))
      .limit(1);
    return project ?? null;
  },
  readSnapshots: async (projectId, label) => {
    const { db, dbSnapshotsTable } = await import("@workspace/db");
    return db
      .select({
        id: dbSnapshotsTable.id,
        provider: dbSnapshotsTable.provider,
        dumpContent: dbSnapshotsTable.dumpContent,
        objectKey: dbSnapshotsTable.objectKey,
        isPartial: dbSnapshotsTable.isPartial,
        sizeBytes: dbSnapshotsTable.sizeBytes,
      })
      .from(dbSnapshotsTable)
      .where(and(eq(dbSnapshotsTable.projectId, projectId), eq(dbSnapshotsTable.label, label)))
      .orderBy(dbSnapshotsTable.id);
  },
  exec: async (runtimeId, projectId) => {
    const { execInContainer } = await import("./tenant-runtime");
    return execInContainer(
      runtimeId,
      [
        "sh",
        "-c",
        `if [ ! -f /data/db.sqlite ]; then printf '${SQLITE_ABSENT_MARKER}'; exit 0; fi; command -v sqlite3 >/dev/null 2>&1 || exit 127; sqlite3 /data/db.sqlite .dump`,
      ],
      projectId,
      "/",
    );
  },
  upload: uploadSnapshotBlob,
  objectExists: snapshotBlobExists,
  insertSnapshot: async (input) => {
    const { db, dbSnapshotsTable } = await import("@workspace/db");
    const [snapshot] = await db
      .insert(dbSnapshotsTable)
      .values({
        projectId: input.projectId,
        versionId: null,
        label: input.label,
        provider: "sqlite",
        dumpContent: input.dumpContent,
        objectKey: input.objectKey,
        isPartial: false,
        sizeBytes: input.sizeBytes,
      })
      .returning({
        id: dbSnapshotsTable.id,
        provider: dbSnapshotsTable.provider,
        dumpContent: dbSnapshotsTable.dumpContent,
        objectKey: dbSnapshotsTable.objectKey,
        isPartial: dbSnapshotsTable.isPartial,
        sizeBytes: dbSnapshotsTable.sizeBytes,
      });
    return snapshot;
  },
  deleteObject: deleteSnapshotBlob,
};

export async function preserveProjectSqliteForRetirement(
  input: { projectId: number; operationId: string },
  dependencies: SqliteRetirementDependencies = defaultSqliteRetirementDependencies,
): Promise<ProjectSqliteRetirementResult> {
  const label = `trash-recovery:${input.operationId}`;
  let uploadedObjectKey: string | null = null;
  try {
    const project = await dependencies.readProject(input.projectId);
    if (project === null) {
      return { ok: false, code: "project_retirement_sqlite_snapshot_unverified", retryable: false };
    }
    if (project.dbProvider !== "sqlite") {
      return {
        ok: true,
        receipt: {
          state: "not_applicable",
          snapshotId: null,
          sizeBytes: 0,
          storage: null,
          failureCode: null,
        },
      };
    }

    for (const snapshot of await dependencies.readSnapshots(input.projectId, label)) {
      const receipt = await verifiedSqliteReceipt(snapshot, dependencies);
      if (receipt) return { ok: true, receipt };
    }

    if (project.containerId === null) {
      if (project.dbStatus !== "none") {
        return {
          ok: false,
          code: "project_retirement_sqlite_snapshot_unverified",
          retryable: true,
        };
      }
      return {
        ok: true,
        receipt: {
          state: "not_present",
          snapshotId: null,
          sizeBytes: 0,
          storage: null,
          failureCode: null,
        },
      };
    }

    const captured = await dependencies.exec(project.containerId, input.projectId);
    if (!captured.ok) {
      return { ok: false, code: "project_retirement_sqlite_snapshot_failed", retryable: true };
    }
    if (captured.output.trim() === SQLITE_ABSENT_MARKER) {
      return {
        ok: true,
        receipt: {
          state: "not_present",
          snapshotId: null,
          sizeBytes: 0,
          storage: null,
          failureCode: null,
        },
      };
    }
    const sizeBytes = Buffer.byteLength(captured.output, "utf8");
    if (sizeBytes <= 0 || sizeBytes > 2_147_483_647) {
      return { ok: false, code: "project_retirement_sqlite_snapshot_unverified", retryable: false };
    }
    uploadedObjectKey = await dependencies.upload(input.projectId, captured.output);
    const snapshot = await dependencies.insertSnapshot({
      projectId: input.projectId,
      label,
      dumpContent: uploadedObjectKey === null ? captured.output : null,
      objectKey: uploadedObjectKey,
      sizeBytes,
    });
    const receipt = await verifiedSqliteReceipt(snapshot, dependencies);
    if (!receipt) {
      return { ok: false, code: "project_retirement_sqlite_snapshot_unverified", retryable: true };
    }
    uploadedObjectKey = null;
    return { ok: true, receipt };
  } catch {
    return { ok: false, code: "project_retirement_sqlite_snapshot_failed", retryable: true };
  } finally {
    if (uploadedObjectKey !== null)
      await dependencies.deleteObject(uploadedObjectKey).catch(() => false);
  }
}
