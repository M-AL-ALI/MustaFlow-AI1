import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { productionDatabaseAllocationIdentity } from "@workspace/tenant-runtime-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  deleteAssetObject: vi.fn(),
  headAssetObject: vi.fn(),
  putAssetStream: vi.fn(),
  openAsset: vi.fn(),
  deleteSnapshotBlob: vi.fn(),
  snapshotBlobExists: vi.fn(),
  getLegacyObject: vi.fn(),
  neonLookup: vi.fn(),
  previewReconcile: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  pool: {
    query: async (...args: unknown[]) => {
      const result = await mocks.poolQuery(...args);
      return {
        ...result,
        rows: result.rows.map((row: Record<string, unknown>) =>
          row && "db_provider" in row && !("preview_db_status" in row)
            ? {
                ...row,
                preview_db_status: "none",
                preview_db_has_url: false,
                preview_db_allocation: null,
              }
            : row,
        ),
      };
    },
    connect: mocks.poolConnect,
  },
}));
vi.mock("./preview-database-allocation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./preview-database-allocation")>()),
  reconcilePreviewDatabaseAllocation: mocks.previewReconcile,
}));
vi.mock("./neon-project-lifecycle", () => ({
  lookupNeonProjectsByStableName: mocks.neonLookup,
  neonProjectNameFor: (id: number) => `mf-project-${id}`,
}));
vi.mock("./asset-r2", () => ({
  deleteAssetObject: mocks.deleteAssetObject,
  headAssetObject: mocks.headAssetObject,
  putAssetStream: mocks.putAssetStream,
  openAsset: mocks.openAsset,
}));
vi.mock("./snapshot-storage", () => ({
  deleteSnapshotBlob: mocks.deleteSnapshotBlob,
  snapshotBlobExists: mocks.snapshotBlobExists,
}));
vi.mock("./project-retirement-contract", () => ({
  hasCurrentProjectRetirementCompletionEvidence: vi.fn(() => true),
  PROJECT_LIFECYCLE_LOCK_NAMESPACE: 1,
}));
vi.mock("./objectStorage", () => ({
  ObjectNotFoundError: class extends Error {},
  ObjectStorageService: class {
    getObjectEntityFile = mocks.getLegacyObject;
  },
}));

import {
  applyProjectRelationalPurge,
  inventoryProjectPurgeResources,
  migrateRetainedLegacyAssetsForPurge,
  projectPurgeLegacyMigrationTargetKey,
  readProjectReferenceCatalog,
  releaseProjectAssetStorage,
  releaseProjectSnapshotStorage,
  validateProjectReferenceCatalog,
  type ProjectPurgeResourceInventory,
} from "./project-purge-resources";
import { ObjectNotFoundError } from "./objectStorage";
import {
  previewDatabaseStateDigest,
  type PreviewDatabaseState,
  type PreviewDatabaseAllocationReceipt,
} from "./preview-database-allocation";

function inventory(
  overrides: Partial<ProjectPurgeResourceInventory> = {},
): ProjectPurgeResourceInventory {
  return {
    projectId: 51,
    ownerId: "owner-user",
    projectName: "Project 51",
    deletedAt: new Date("2026-09-01T00:00:00.000Z"),
    retirementOperationId: "retirement-51",
    retirementProgress: {},
    neonProjectIds: [],
    productionNeonProjectName: "mf-project-51",
    previewNeonProjectName: "mf-preview-51",
    previewDatabase: { status: "none", hasCredential: false, allocation: null },
    assetTargets: [],
    legacyGeneratedImageTargets: [],
    uploadTargets: [],
    snapshotObjectKeys: [],
    tableCounts: [],
    activeAddonCount: 0,
    digestSha256: "a".repeat(64),
    ...overrides,
  };
}

function assetClaimClient(
  shared = false,
  state = "ready",
  aliases: readonly string[] = [],
  options: {
    storageKeys?: readonly string[];
    rawSharedKeys?: readonly string[];
    primaryKey?: string;
    storageBackend?: string;
    softDeletedImageKey?: string;
    imageStorageAliases?: Array<{
      id: number;
      asset_id: number;
      storage_key: string | null;
      file_url: string | null;
      thumbnail_url: string | null;
    }>;
  } = {},
) {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const query = vi.fn(async (statement: string, values: readonly unknown[] = []) => {
    const sql = statement.replace(/\s+/gu, " ").trim();
    statements.push({ sql, values });
    if (sql.startsWith("SELECT product_scope, storage_backend FROM assets")) {
      return {
        rows: [{ product_scope: "nabuflow", storage_backend: options.storageBackend ?? "r2" }],
        rowCount: 1,
      };
    }
    if (sql.includes("/* purge-asset-row-lock */")) {
      return {
        rows: [{ state, storage_key: options.primaryKey ?? "", product_scope: "nabuflow" }],
        rowCount: 1,
      };
    }
    if (sql.includes("/* purge-asset-storage-")) {
      const rows = (options.storageKeys ?? []).map((storage_key, index) => ({
        id: index + 1,
        asset_id: Number(values[0]),
        storage_key,
        storage_backend: "r2",
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("/* purge-image-storage-aliases */")) {
      const rows = options.imageStorageAliases ?? [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("/* purge-asset-image-metadata */")) {
      const rows = (options.imageStorageAliases ?? []).map(({ id }) => ({ id }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("/* purge-asset-key-order */")) {
      const rows = [...new Set(values[0] as string[])]
        .sort()
        .map((storage_key) => ({ storage_key }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT storage_key FROM asset_storage_objects")) {
      const rows = (options.storageKeys ?? []).map((storage_key) => ({ storage_key }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT '/api/images/'")) {
      return { rows: aliases.map((alias) => ({ alias })), rowCount: aliases.length };
    }
    if (sql.startsWith("WITH durable_reference_rows")) {
      return { rows: [{ allowed: true }], rowCount: 1 };
    }
    if (sql.includes("public.durable_asset_reference_exists")) {
      return { rows: [{ shared }], rowCount: 1 };
    }
    if (sql.endsWith(") AS shared")) {
      const storageKey = String(values[1] ?? "");
      const softDeletedImageSurvives =
        storageKey === options.softDeletedImageKey && !sql.includes("image_row.deleted_at IS NULL");
      return {
        rows: [
          {
            shared:
              shared ||
              softDeletedImageSurvives ||
              (options.rawSharedKeys ?? []).includes(storageKey),
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.startsWith("SELECT 1 FROM durable_asset_deletion_claims")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO durable_asset_deletion_claims")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO asset_usage")) return { rows: [], rowCount: 1 };
    if (sql.startsWith("UPDATE assets SET state='deleting'")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE asset_storage_objects SET state='deleting'")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query, release: vi.fn(), statements };
}

function legacyMigrationClient(input: { digest: string; sourceKey: string; targetKey: string }) {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  let assetMigrated = false;
  let claimPresent = false;
  let sourceDeleted = false;
  let sourceRole = "primary";
  const query = vi.fn(async (statement: string, values: readonly unknown[] = []) => {
    const sql = statement.replace(/\s+/gu, " ").trim();
    statements.push({ sql, values });
    if (sql.startsWith("SELECT owner_user_id, project_id, product_scope")) {
      return {
        rows: [
          {
            owner_user_id: "owner-user",
            project_id: 51,
            product_scope: "nabuflow",
            state: "ready",
            source: "legacy-project-upload",
            sha256: null,
            storage_backend: "legacy-object",
            storage_key: input.sourceKey,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.startsWith("SELECT storage_backend, storage_key, state FROM assets")) {
      return {
        rows: [
          {
            storage_backend: assetMigrated ? "r2" : "legacy-object",
            storage_key: assetMigrated ? input.targetKey : input.sourceKey,
            state: "ready",
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.startsWith("SELECT id, storage_backend, storage_key, role, state")) {
      return {
        rows: [
          {
            id: 11,
            storage_backend: "legacy-object",
            storage_key: input.sourceKey,
            role: sourceRole,
            state: sourceDeleted ? "deleted" : sourceRole === "primary" ? "ready" : "deleting",
          },
          {
            id: 12,
            storage_backend: "r2",
            storage_key: input.targetKey,
            role: `project-purge-r2-target:${input.digest}`,
            state: "uploading",
          },
        ],
        rowCount: 2,
      };
    }
    if (sql.startsWith("SELECT storage_key FROM (")) {
      const rows = [...new Set(values[0] as string[])]
        .sort()
        .map((storage_key) => ({ storage_key }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT (") && sql.includes(" AS ambiguous")) {
      return { rows: [{ ambiguous: false }], rowCount: 1 };
    }
    if (sql.startsWith("WITH durable_reference_rows")) {
      return { rows: [{ allowed: true }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT '/api/images/'")) return { rows: [], rowCount: 0 };
    if (sql.includes("public.durable_asset_reference_exists")) {
      return { rows: [{ shared: true }], rowCount: 1 };
    }
    if (sql.endsWith(") AS shared")) {
      return { rows: [{ shared: false }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO durable_asset_deletion_claims")) {
      claimPresent = true;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT claim_kind, retired_project_id, retired_asset_id")) {
      return claimPresent
        ? {
            rows: [
              {
                claim_kind: "project-purge-migration",
                retired_project_id: 51,
                retired_asset_id: 2,
              },
            ],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("UPDATE asset_storage_objects SET role=$2, state='deleting'")) {
      sourceRole = String(values[1]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE asset_storage_objects SET role='primary'")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE assets SET storage_backend='r2'")) {
      assetMigrated = true;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE asset_storage_objects SET state='deleted'")) {
      if (values[3] !== sourceRole) return { rows: [], rowCount: 0 };
      sourceDeleted = true;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT state FROM asset_storage_objects")) {
      return { rows: [{ state: sourceDeleted ? "deleted" : "deleting" }], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM durable_asset_deletion_claims")) {
      claimPresent = false;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO asset_usage")) return { rows: [], rowCount: 1 };
    if (sql.startsWith("SELECT id FROM generated_images")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT id FROM project_uploads")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
  return {
    query,
    release: vi.fn(),
    statements,
    claimPresent: () => claimPresent,
    sourceDeleted: () => sourceDeleted,
    sourceRole: () => sourceRole,
  };
}

function legacyProviderFixture(rewriteDuringDelete: boolean) {
  const bytes = Buffer.from("legacy-provider-object");
  let currentGeneration = "1";
  let deleted = false;
  const deleteFile = vi.fn(
    async (options: { ignoreNotFound: boolean; ifGenerationMatch: string }) => {
      if (rewriteDuringDelete) currentGeneration = "2";
      if (options.ifGenerationMatch !== currentGeneration) {
        throw new Error("conditionNotMet");
      }
      deleted = true;
    },
  );
  const file = {
    getMetadata: vi.fn(async () => [
      {
        size: String(bytes.length),
        generation: currentGeneration,
        contentType: "application/octet-stream",
        md5Hash: `checksum-${currentGeneration}`,
      },
    ]),
    createReadStream: () => Readable.from([bytes]),
    delete: deleteFile,
  };
  mocks.getLegacyObject.mockImplementation(async () => {
    if (deleted) throw new ObjectNotFoundError();
    return file;
  });
  mocks.putAssetStream.mockImplementation(async (request: { body: AsyncIterable<Uint8Array> }) => {
    for await (const _chunk of request.body) {
      // Drain the measured source stream exactly as the provider client does.
    }
  });
  mocks.headAssetObject.mockResolvedValue({ sizeBytes: bytes.length });
  mocks.openAsset.mockResolvedValue({ body: Readable.from([bytes]), sizeBytes: bytes.length });
  return {
    deleteFile,
    currentGeneration: () => currentGeneration,
    deleted: () => deleted,
  };
}

function noForeignKey(tableName: string, columnName: "project_id" | "source_project_id") {
  return {
    tableName,
    columnName,
    deleteAction: "no_fk" as const,
    foreignKeyCount: 0,
    referencedTableSchema: null,
    referencedTableName: null,
    referencedColumnName: null,
  };
}

function projectsForeignKey(
  tableName: string,
  columnName: "project_id" | "source_project_id",
  deleteAction: "cascade" | "set_null" | "restrict",
) {
  return {
    tableName,
    columnName,
    deleteAction,
    foreignKeyCount: 1,
    referencedTableSchema: "public",
    referencedTableName: "projects",
    referencedColumnName: "id",
  };
}

const productionDatabaseAdmissionCatalogRow = {
  table_name: "production_database_admission_receipts",
  column_name: "project_id",
  delete_action: "no_fk",
  foreign_key_count: 0,
  referenced_table_schema: null,
  referenced_table_name: null,
  referenced_column_name: null,
};

async function sealedAdmissionRow(projectId: number) {
  return {
    project_id: projectId,
    registration_epoch: "00000000-0000-4000-8000-000000000001",
    birth_token: "00000000-0000-4000-8000-000000000002",
    birth_registered: false,
    allocation_identity: await productionDatabaseAllocationIdentity({
      format: "nabuflow.production-database-allocation/v1",
      deploymentNamespace: "production",
      projectId,
    }),
    state: "sealed",
    seal_id: "00000000-0000-4000-8000-000000000003",
  };
}

function relationalClient(input: {
  leaseVersion: number;
  expectedLeaseVersion?: number;
  unresolvedNeon?: boolean;
  preview?: PreviewDatabaseState;
  legacyPreviewCheckpoint?: boolean;
  previewEvidence?: unknown;
  finalAssets?: Array<{
    id: number;
    project_id: number | null;
    state: string;
    storage_key: string;
    product_scope: string | null;
    storage_backend?: string;
  }>;
  finalAliases?: Array<{
    kind: "image" | "upload";
    id: number;
    alias: string;
    asset_id: number | null;
    storage_key: string | null;
    active?: boolean;
  }>;
  refreshedFinalAliases?: Array<{
    kind: "image" | "upload";
    id: number;
    alias: string;
    asset_id: number | null;
    storage_key: string | null;
    active?: boolean;
  }>;
  finalStorage?: Array<{
    id: number;
    asset_id: number;
    storage_key: string;
    storage_backend?: string;
    state?: string;
  }>;
  preservedAssetIds?: readonly number[];
  finalReferenceSequence?: readonly boolean[];
  modelAssetRehome?: boolean;
  resourceProgress?: Record<string, unknown> | null;
  finalReferenced?: boolean;
  finalRawSharedKeys?: readonly string[];
  admission?: Record<string, unknown> | null;
  admissionAfterProjectDelete?: Record<string, unknown> | null;
}) {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  let projectDeleted = false;
  let resourceProgress = input.resourceProgress;
  let finalReferenceIndex = 0;
  const finalAssets = (input.finalAssets ?? []).map((asset) => ({
    storage_backend: "r2",
    ...asset,
  }));
  const finalStorage = (input.finalStorage ?? []).map((object) => ({
    storage_backend: "r2",
    state: "ready",
    ...object,
  }));
  const preservedAssetIds = new Set(input.preservedAssetIds ?? []);
  const deletionClaims = new Map<
    string,
    { claim_kind: string; retired_project_id: number; retired_asset_id: number }
  >();
  const query = vi.fn(async (statement: string, values: readonly unknown[] = []) => {
    const sql = statement.replace(/\s+/gu, " ").trim();
    statements.push({ sql, values });
    if (sql.startsWith("SELECT state, lease_version")) {
      const pristine = { status: "none", hasCredential: false, allocation: null };
      if (resourceProgress === undefined) {
        resourceProgress = input.legacyPreviewCheckpoint
          ? { databaseComplete: true }
          : {
              databaseComplete: true,
              previewDatabaseEvidence: input.previewEvidence ?? {
                version: 1,
                kind: "no-dispatch",
                stateDigest: previewDatabaseStateDigest(Number(values[1]), pristine),
              },
            };
      }
      return {
        rows: [
          {
            state: "running",
            lease_version: input.leaseVersion,
            resource_progress: resourceProgress,
          },
        ],
        rowCount: 1,
      };
    }
    if (
      sql.startsWith("SELECT deleted_at, db_provider, db_status, neon_project_id, db_connection_id")
    ) {
      return {
        rows: [
          {
            deleted_at: new Date("2026-09-01T00:00:00.000Z"),
            db_provider: input.unresolvedNeon ? "postgres" : "none",
            db_status: input.unresolvedNeon ? "error" : "none",
            neon_project_id: null,
            db_connection_id: null,
            preview_db_status: input.preview?.status ?? "none",
            preview_db_has_url: input.preview?.hasCredential ?? false,
            preview_db_allocation: input.preview?.allocation ?? null,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.startsWith("SELECT project_id, registration_epoch, birth_token, birth_registered")) {
      const admission =
        projectDeleted && input.admissionAfterProjectDelete !== undefined
          ? input.admissionAfterProjectDelete
          : input.admission;
      if (admission === null) return { rows: [], rowCount: 0 };
      return {
        rows: [{ ...(await sealedAdmissionRow(Number(values[0]))), ...admission }],
        rowCount: 1,
      };
    }
    if (
      sql.includes("/* purge-final-assets-lock */") ||
      sql.includes("/* purge-final-assets-refresh */")
    ) {
      const rows = finalAssets;
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("/* purge-final-storage-")) {
      const rows = finalStorage.filter((object) => object.state !== "deleted");
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("/* purge-image-storage-aliases */")) {
      const rows = (input.finalAliases ?? [])
        .filter(
          (alias) => alias.kind === "image" && alias.asset_id !== null && alias.active !== false,
        )
        .map((alias) => ({ ...alias, file_url: null, thumbnail_url: null }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("/* purge-final-alias-plan */")) {
      const refreshed = statements.some(({ sql: entry }) =>
        entry.includes("/* purge-final-assets-refresh */"),
      );
      const rows = refreshed
        ? (input.refreshedFinalAliases ?? input.finalAliases ?? [])
        : (input.finalAliases ?? []);
      const activeRows = rows.map((alias) => ({ active: alias.active ?? true, ...alias }));
      return { rows: activeRows, rowCount: activeRows.length };
    }
    if (sql.includes("/* purge-final-key-order */")) {
      const rows = [...new Set(values[0] as string[])]
        .sort()
        .map((storage_key) => ({ storage_key }));
      return { rows, rowCount: rows.length };
    }
    if (
      sql.includes("/* purge-final-image-metadata */") ||
      sql.includes("/* purge-final-upload-metadata */")
    ) {
      const kind = sql.includes("image-metadata") ? "image" : "upload";
      const rows = (input.finalAliases ?? [])
        .filter((alias) => alias.kind === kind)
        .map(({ id }) => ({ id }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("public.durable_asset_reference_exists")) {
      const shared = input.finalReferenceSequence
        ? (input.finalReferenceSequence[
            Math.min(finalReferenceIndex++, input.finalReferenceSequence.length - 1)
          ] ?? false)
        : (input.finalReferenced ?? false);
      return { rows: [{ shared }], rowCount: 1 };
    }
    if (sql.endsWith(") AS shared")) {
      return {
        rows: [{ shared: (input.finalRawSharedKeys ?? []).includes(String(values[1])) }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("WITH durable_reference_rows")) {
      return { rows: [{ allowed: true }], rowCount: 1 };
    }
    if (
      sql.startsWith("SELECT asset_id FROM asset_usage") &&
      sql.includes("project-purge-preserved-direct:")
    ) {
      const rows = [...preservedAssetIds].map((asset_id) => ({ asset_id }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("INSERT INTO asset_usage")) {
      preservedAssetIds.add(Number(values[0]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT 1 FROM durable_asset_deletion_claims")) {
      const keys = values[0] as string[];
      const rows = keys.filter((key) => deletionClaims.has(key)).map(() => ({ one: 1 }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("INSERT INTO durable_asset_deletion_claims")) {
      const key = String(values[0]);
      if (deletionClaims.has(key)) return { rows: [], rowCount: 0 };
      deletionClaims.set(key, {
        claim_kind: "project-purge-preservation-reconcile",
        retired_project_id: Number(values[1]),
        retired_asset_id: Number(values[2]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT claim_kind, retired_project_id, retired_asset_id")) {
      const claim = deletionClaims.get(String(values[0]));
      return claim ? { rows: [claim], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("UPDATE assets SET state='deleting'")) {
      const asset = finalAssets.find((row) => row.id === Number(values[0]));
      if (!asset || asset.project_id !== Number(values[1])) return { rows: [], rowCount: 0 };
      asset.state = "deleting";
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE asset_storage_objects SET state='deleting'")) {
      const ids = values[0] as number[];
      let changed = 0;
      for (const object of finalStorage) {
        if (ids.includes(object.id) && object.asset_id === Number(values[1])) {
          object.state = "deleting";
          changed += 1;
        }
      }
      return { rows: [], rowCount: changed };
    }
    if (sql === "SELECT 1 FROM projects WHERE id=$1 FOR UPDATE") {
      return projectDeleted ? { rows: [], rowCount: 0 } : { rows: [{ one: 1 }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT id, state FROM assets WHERE id=ANY")) {
      const ids = values[0] as number[];
      const rows = finalAssets.filter((asset) => ids.includes(asset.id));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT asset_id, storage_backend, storage_key, state")) {
      const object = finalStorage.find((row) => row.id === Number(values[0]));
      return object ? { rows: [object], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("UPDATE asset_storage_objects SET state='deleted'")) {
      const object = finalStorage.find((row) => row.id === Number(values[0]));
      if (!object || object.asset_id !== Number(values[1])) return { rows: [], rowCount: 0 };
      object.state = "deleted";
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE assets asset_row SET state='deleted'")) {
      const ids = values[0] as number[];
      for (const asset of finalAssets) {
        if (
          ids.includes(asset.id) &&
          asset.project_id === Number(values[1]) &&
          !finalStorage.some((object) => object.asset_id === asset.id && object.state !== "deleted")
        ) {
          asset.state = "deleted";
        }
      }
      return { rows: [], rowCount: ids.length };
    }
    if (sql.startsWith("DELETE FROM asset_usage") && sql.includes("asset_id=ANY($1::integer[])")) {
      for (const id of values[0] as number[]) preservedAssetIds.delete(id);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE project_purge_operations SET resource_progress=$3::jsonb")) {
      resourceProgress = JSON.parse(String(values[2])) as Record<string, unknown>;
      return { rows: [], rowCount: values[3] === input.leaseVersion ? 1 : 0 };
    }
    if (sql.startsWith("DELETE FROM durable_asset_deletion_claims")) {
      for (const key of values[0] as string[]) deletionClaims.delete(key);
      return { rows: [], rowCount: 1 };
    }
    if (
      /^DELETE FROM (generated_images|project_uploads) WHERE project_id=\$1 RETURNING id$/u.test(
        sql,
      )
    ) {
      const kind = sql.includes("generated_images") ? "image" : "upload";
      const rows = (input.finalAliases ?? [])
        .filter((alias) => alias.kind === kind)
        .map(({ id }) => ({ id }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT DISTINCT asset_row.id")) return { rows: [], rowCount: 0 };
    if (sql.includes("COALESCE(SUM(asset_row.size_bytes)")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT 0::integer AS ordinal")) {
      return {
        rows: [
          { ordinal: 0, row_count: 0 },
          { ordinal: 1, row_count: 0 },
        ],
        rowCount: 2,
      };
    }
    if (sql === "SELECT 1 FROM projects WHERE id=$1") return { rows: [], rowCount: 0 };
    if (sql === "DELETE FROM projects WHERE id=$1") {
      projectDeleted = true;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM project_github_connections")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE notifications SET project_id=NULL")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE purchased_domains SET project_id=NULL")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE assets asset_row SET project_id=NULL")) {
      if (!input.modelAssetRehome) return { rows: [], rowCount: 0 };
      const rows = finalAssets.filter(
        (asset) =>
          asset.project_id === Number(values[0]) &&
          asset.state === "ready" &&
          preservedAssetIds.has(asset.id),
      );
      for (const asset of rows) asset.project_id = null;
      return { rows: [], rowCount: rows.length };
    }
    if (sql.startsWith("UPDATE project_purge_operations SET state='completed'")) {
      const expected = input.expectedLeaseVersion ?? input.leaseVersion;
      return { rows: [], rowCount: values[3] === expected ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query, release: vi.fn(), statements };
}

describe("project purge resource safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.poolQuery.mockReset().mockResolvedValue({ rows: [{ shared: false }], rowCount: 1 });
    mocks.poolConnect.mockReset().mockImplementation(async () => assetClaimClient(false));
    mocks.deleteAssetObject.mockReset();
    mocks.headAssetObject.mockReset();
    mocks.putAssetStream.mockReset();
    mocks.openAsset.mockReset();
    mocks.deleteSnapshotBlob.mockReset();
    mocks.snapshotBlobExists.mockReset();
    mocks.getLegacyObject.mockReset();
    mocks.neonLookup.mockReset().mockResolvedValue({ kind: "absent" });
    mocks.previewReconcile.mockReset();
  });

  it.each(["nabuflow", "ora"] as const)(
    "fences final aliases and rehomes %s assets without promoting provenance or granting reuse",
    async (productScope) => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
      const client = relationalClient({
        leaseVersion: 4,
        finalReferenced: true,
        finalAssets: [
          {
            id: 19,
            project_id: 77,
            state: "ready",
            storage_key: "isolation/final/full.webp",
            product_scope: productScope,
          },
        ],
        finalAliases: [
          {
            kind: "image",
            id: 81,
            alias: "/api/images/81/file",
            asset_id: 19,
            storage_key: "isolation/final/full.webp",
          },
          {
            kind: "upload",
            id: 82,
            alias: "/api/projects/77/uploads/82/content",
            asset_id: 19,
            storage_key: "isolation/final/full.webp",
          },
        ],
      });
      mocks.poolConnect.mockResolvedValueOnce(client);
      await applyProjectRelationalPurge(77, "operation-77", {
        inventoryDigestSha256: "a".repeat(64),
        providerRemoved: 0,
        providerDetached: 0,
        leaseVersion: 4,
      });
      const statements = client.statements.map(({ sql }) => sql);
      const index = (marker: string) => statements.findIndex((sql) => sql.includes(marker));
      expect(statements).toContain("BEGIN ISOLATION LEVEL READ COMMITTED");
      expect(index("/* purge-final-assets-lock */")).toBeLessThan(
        index("/* purge-final-storage-lock */"),
      );
      expect(index("/* purge-final-storage-lock */")).toBeLessThan(
        index("nabuflow:durable-object:"),
      );
      expect(index("nabuflow:durable-object:")).toBeLessThan(
        index("/* purge-final-image-metadata */"),
      );
      expect(index("/* purge-final-image-metadata */")).toBeLessThan(
        index("/* purge-final-upload-metadata */"),
      );
      expect(index("/* purge-final-upload-metadata */")).toBeLessThan(
        index("/* purge-final-assets-refresh */"),
      );
      expect(index("/* purge-final-assets-refresh */")).toBeLessThan(index("UPDATE project_files"));
      expect(index("UPDATE project_files")).toBeLessThan(index("DELETE FROM generated_images"));
      expect(index("DELETE FROM generated_images")).toBeLessThan(
        index("DELETE FROM project_uploads"),
      );
      expect(index("DELETE FROM project_uploads")).toBeLessThan(index("DELETE FROM projects"));
      const canonical =
        productScope === "ora" ? "/api/ora/canonical-assets/19/content" : "/api/assets/19/content";
      expect(
        client.statements
          .filter(({ sql }) => sql.startsWith("UPDATE project_files"))
          .map(({ values }) => values),
      ).toEqual([
        [77, "/api/images/81/file", canonical],
        [77, "/api/projects/77/uploads/82/content", canonical],
      ]);
      const rehome = statements.find((sql) => sql.startsWith("UPDATE assets asset_row"));
      expect(rehome).toContain("SET project_id=NULL, thread_key=NULL");
      expect(rehome).not.toMatch(/\b(?:scope|product_scope|owner_user_id)\s*=/u);
      const insertions = statements.filter((sql) => sql.startsWith("INSERT INTO asset_usage"));
      expect(insertions).toHaveLength(1);
      expect(insertions[0]).toContain("project-purge-preserved-direct:");
      expect(insertions[0]).not.toContain("explicit-project-use:v1");
      expect(index("UPDATE assets asset_row")).toBeLessThan(index("DELETE FROM asset_usage"));
      expect(statements.find((sql) => sql.startsWith("DELETE FROM asset_usage"))).toBe(
        "DELETE FROM asset_usage WHERE project_id=$1 OR consumer='project-purge-preserved-direct:' || $1::text",
      );
      expect(statements).toContain("COMMIT");
      expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
      expect(mocks.deleteSnapshotBlob).not.toHaveBeenCalled();
    },
  );

  it.each(["asset", "key", "metadata"] as const)(
    "rolls back before deletion when final alias refresh discovers an unlocked %s",
    async (change) => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
      const alias = {
        kind: "image" as const,
        id: 81,
        alias: "/api/images/81/file",
        asset_id: 19,
        storage_key: "isolation/locked",
      };
      const client = relationalClient({
        leaseVersion: 4,
        finalAssets: [
          {
            id: 19,
            project_id: 88,
            state: "ready",
            storage_key: "isolation/locked",
            product_scope: "nabuflow",
          },
        ],
        finalAliases: [alias],
        refreshedFinalAliases: [
          {
            ...alias,
            ...(change === "asset"
              ? { asset_id: 20 }
              : change === "key"
                ? { storage_key: "isolation/unlocked" }
                : { id: 82 }),
          },
        ],
      });
      mocks.poolConnect.mockResolvedValueOnce(client);
      await expect(
        applyProjectRelationalPurge(77, "operation-77", {
          inventoryDigestSha256: "a".repeat(64),
          providerRemoved: 0,
          providerDetached: 0,
          leaseVersion: 4,
        }),
      ).rejects.toThrow("project_purge_asset_release_failed");
      const statements = client.statements.map(({ sql }) => sql);
      expect(statements.some((sql) => sql.startsWith("DELETE "))).toBe(false);
      expect(statements).toContain("ROLLBACK");
      expect(statements).not.toContain("COMMIT");
      const lock = statements.find((sql) => sql.includes("/* purge-final-assets-lock */"))!;
      expect(lock).toContain("image.asset_id=asset_row.id");
      expect(lock).toContain("upload.object_path=asset_row.storage_key");
    },
  );

  it.each(["image", "upload"] as const)(
    "retains unknown-origin %s metadata and bytes without a guessed canonical route",
    async (kind) => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
      const client = relationalClient({
        leaseVersion: 4,
        finalReferenced: true,
        finalAssets: [
          {
            id: 19,
            project_id: 77,
            state: "ready",
            storage_key: "isolation/unknown",
            product_scope: null,
          },
        ],
        finalAliases: [
          {
            kind,
            id: 81,
            alias: kind === "image" ? "/api/images/81/file" : "/api/projects/77/uploads/81/content",
            asset_id: 19,
            storage_key: "isolation/unknown",
          },
        ],
      });
      mocks.poolConnect.mockResolvedValueOnce(client);
      await expect(
        applyProjectRelationalPurge(77, "operation-77", {
          inventoryDigestSha256: "a".repeat(64),
          providerRemoved: 0,
          providerDetached: 0,
          leaseVersion: 4,
        }),
      ).rejects.toThrow("project_purge_asset_origin_unresolved");
      const statements = client.statements.map(({ sql }) => sql);
      expect(
        statements.some(
          (sql) =>
            sql.startsWith("DELETE ") ||
            sql.startsWith("UPDATE project_files") ||
            sql.startsWith("INSERT INTO asset_usage"),
        ),
      ).toBe(false);
      expect(statements).toContain("ROLLBACK");
      expect(statements).not.toContain("COMMIT");
      expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
      expect(mocks.deleteSnapshotBlob).not.toHaveBeenCalled();
    },
  );

  it.each(["full", "thumb"] as const)(
    "blocks physical asset release for an unregistered alias-only %s reference",
    async (part) => {
      const fullKey = "generated-images/historical/full.webp";
      const referencedKey = "generated-images/historical/" + part + ".webp";
      const primaryKey = "accounts/owner/registered.webp";
      const claim = assetClaimClient(false, "ready", [], {
        primaryKey,
        storageKeys: [primaryKey],
        rawSharedKeys: [referencedKey],
        imageStorageAliases: [
          { id: 81, asset_id: 19, storage_key: fullKey, file_url: null, thumbnail_url: null },
        ],
      });
      mocks.poolConnect.mockResolvedValueOnce(claim);
      await expect(
        releaseProjectAssetStorage(
          inventory({
            projectId: 77,
            assetTargets: [
              {
                assetId: 19,
                ownerUserId: "owner-user",
                shared: false,
                storageBackend: "r2",
                storageKey: primaryKey,
                sizeBytes: 1,
              },
            ],
          }),
        ),
      ).rejects.toThrow("project_purge_asset_release_failed");
      const statements = claim.statements.map(({ sql }) => sql);
      expect(statements).toContain("ROLLBACK");
      expect(
        statements.some(
          (sql) =>
            sql.startsWith("UPDATE assets") ||
            sql.startsWith("INSERT INTO durable_asset_deletion_claims"),
        ),
      ).toBe(false);
      const lockedKeys = claim.statements
        .filter(({ sql }) => sql.includes("pg_advisory_xact_lock"))
        .map(({ values }) => values[0]);
      expect(lockedKeys).toContain(fullKey);
      expect(lockedKeys).toContain("generated-images/historical/thumb.webp");
      expect(
        claim.statements.some(
          ({ sql, values }) => sql.endsWith(") AS shared") && values[1] === referencedKey,
        ),
      ).toBe(true);
      expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
    },
  );

  it.each(["full", "thumb"] as const)(
    "blocks final deletion for an unregistered alias-only %s reference",
    async (part) => {
      const referencedKey = "generated-images/historical/" + part + ".webp";
      mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
      const client = relationalClient({
        leaseVersion: 4,
        finalReferenced: false,
        finalRawSharedKeys: [referencedKey],
        finalAssets: [
          {
            id: 19,
            project_id: 77,
            state: "ready",
            storage_key: "accounts/owner/registered.webp",
            product_scope: "nabuflow",
          },
        ],
        finalAliases: [
          {
            kind: "image",
            id: 81,
            alias: "/api/images/81/file",
            asset_id: 19,
            storage_key: "generated-images/historical/full.webp",
          },
        ],
      });
      mocks.poolConnect.mockResolvedValueOnce(client);
      await expect(
        applyProjectRelationalPurge(77, "operation-77", {
          inventoryDigestSha256: "a".repeat(64),
          providerRemoved: 0,
          providerDetached: 0,
          leaseVersion: 4,
        }),
      ).rejects.toThrow("project_purge_asset_release_failed");
      const statements = client.statements.map(({ sql }) => sql);
      expect(statements).toContain("ROLLBACK");
      expect(
        statements.some(
          (sql) => sql.startsWith("DELETE ") || sql.startsWith("INSERT INTO asset_usage"),
        ),
      ).toBe(false);
      expect(
        client.statements.some(
          ({ sql, values }) => sql.endsWith(") AS shared") && values[1] === referencedKey,
        ),
      ).toBe(true);
      expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
    },
  );

  it("accepts declared project references and fails closed on a new undeclared table", () => {
    expect(
      validateProjectReferenceCatalog([
        projectsForeignKey("support_access_grants", "project_id", "restrict"),
        noForeignKey("purchased_domains", "project_id"),
        noForeignKey("production_database_admission_receipts", "project_id"),
        projectsForeignKey("project_files", "project_id", "cascade"),
      ]),
    ).toMatchObject({ ok: true });
    expect(
      validateProjectReferenceCatalog([noForeignKey("new_project_store", "project_id")]),
    ).toEqual({ ok: false, unknown: ["new_project_store.project_id"] });
  });

  it("rejects a same-named cascade that does not reference public projects(id)", () => {
    expect(
      validateProjectReferenceCatalog([
        {
          ...projectsForeignKey("project_files", "project_id", "cascade"),
          referencedTableName: "other_projects",
        },
      ]),
    ).toEqual({ ok: false, unknown: ["project_files.project_id"] });
    expect(
      validateProjectReferenceCatalog([
        {
          ...projectsForeignKey("project_files", "project_id", "cascade"),
          foreignKeyCount: 2,
        },
      ]),
    ).toEqual({ ok: false, unknown: ["project_files.project_id"] });
  });

  it("reads the target schema, table, column, and full foreign-key count from the live catalog", async () => {
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [
        {
          table_name: "project_files",
          column_name: "project_id",
          delete_action: "cascade",
          foreign_key_count: 1,
          referenced_table_schema: "public",
          referenced_table_name: "projects",
          referenced_column_name: "id",
        },
      ],
    });

    await expect(readProjectReferenceCatalog()).resolves.toEqual([
      projectsForeignKey("project_files", "project_id", "cascade"),
    ]);
    const query = String(mocks.poolQuery.mock.calls[0]?.[0]);
    expect(query).toContain("COUNT(*)::integer AS foreign_key_count");
    expect(query).toContain("referenced_namespace.nspname");
    expect(query).not.toContain("LIMIT 1");
  });

  it("accepts declared other-product foreign keys without weakening project-owned FK validation", () => {
    expect(
      validateProjectReferenceCatalog([
        {
          ...projectsForeignKey("orax_threads", "project_id", "restrict"),
          referencedTableName: "orax_desktop_local_folders",
        },
        {
          ...projectsForeignKey("orax_usage_events", "project_id", "restrict"),
          referencedTableName: "orax_desktop_local_folders",
        },
      ]),
    ).toMatchObject({ ok: true });

    expect(
      validateProjectReferenceCatalog([
        {
          ...projectsForeignKey("project_files", "project_id", "restrict"),
          referencedTableName: "orax_desktop_local_folders",
        },
      ]),
    ).toMatchObject({
      ok: false,
      unknown: ["project_files.project_id"],
    });
  });

  it("classifies every real Orax project-shaped column as another product", () => {
    const migration = readFileSync(new URL("./startup-migrations.ts", import.meta.url), "utf8");
    const oraxTables = [
      ...migration.matchAll(/CREATE TABLE IF NOT EXISTS (orax_[a-z_]+)\s*\(([\s\S]*?)\n\s*\)/gu),
    ]
      .filter(([, , body]) => /\bproject_id\b/u.test(body ?? ""))
      .map(([, tableName]) => tableName!)
      .sort();
    expect(oraxTables).toEqual([
      "orax_audit_log",
      "orax_project_sources",
      "orax_threads",
      "orax_usage_events",
    ]);
    expect(
      validateProjectReferenceCatalog(
        oraxTables.map((tableName) => ({
          ...noForeignKey(tableName, "project_id"),
        })),
      ),
    ).toMatchObject({ ok: true });
  });

  it("selects the newest retirement receipt without hiding a newer failed receipt", async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });

    await expect(inventoryProjectPurgeResources(51)).resolves.toBeNull();
    const projectQuery = String(mocks.poolQuery.mock.calls[1]?.[0]);
    expect(projectQuery).toContain("ORDER BY operation.created_at DESC");
    expect(projectQuery).toContain("operation.state");
    expect(projectQuery).toContain("operation.completed_at");
    expect(projectQuery).not.toContain("operation.state='completed'");
  });

  it("classifies a mirrored legacy upload as shared from surviving storage and usage references", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 51,
            owner_id: "owner-user",
            name: "Project 51",
            deleted_at: new Date("2026-09-01T00:00:00.000Z"),
            neon_project_id: null,
            db_connection_id: null,
            db_provider: "none",
            db_status: "none",
            retirement_operation_id: "retirement-51",
            retirement_state: "completed",
            retirement_completed_at: new Date("2026-09-01T00:00:00.000Z"),
            retirement_progress: {},
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ object_path: "/objects/shared-upload", shared: true }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ active_count: 0 }] });

    const result = await inventoryProjectPurgeResources(51);
    expect(result?.uploadTargets).toEqual([{ objectPath: "/objects/shared-upload", shared: true }]);
    const uploadQuery = String(mocks.poolQuery.mock.calls[3]?.[0]);
    expect(uploadQuery).toContain("FROM asset_storage_objects storage_row");
    expect(uploadQuery).toContain("FROM asset_usage usage_row");
    expect(uploadQuery).toContain("other_upload.project_id IS DISTINCT FROM $1");
    mocks.poolConnect.mockResolvedValueOnce(assetClaimClient(true));
    await expect(releaseProjectAssetStorage(result!)).resolves.toMatchObject({
      deletedObjects: 0,
      detachedObjects: 1,
      complete: true,
    });
    expect(mocks.getLegacyObject).not.toHaveBeenCalled();
  });

  it.each([{ kind: "absent" }, { kind: "unavailable" }])(
    "retains an unresolved allocation before any destructive inventory work",
    async (lookup) => {
      mocks.neonLookup.mockResolvedValue(lookup);
      mocks.poolQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
        rows: [
          {
            id: 77,
            owner_id: "fixture-owner",
            name: "Fixture",
            deleted_at: new Date("2026-09-01T00:00:00.000Z"),
            db_provider: "postgres",
            db_status: "error",
            neon_project_id: null,
            db_connection_id: null,
            retirement_operation_id: "retirement-77",
            retirement_state: "completed",
            retirement_completed_at: new Date("2026-09-01T00:00:00.000Z"),
            retirement_progress: {},
          },
        ],
      });
      await expect(inventoryProjectPurgeResources(77)).rejects.toThrow(
        "project_purge_neon_allocation_unresolved",
      );
      expect(mocks.poolQuery).toHaveBeenCalledTimes(2);
      expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
      expect(mocks.deleteSnapshotBlob).not.toHaveBeenCalled();
    },
  );

  it("recovers delayed allocation ownership on a purge retry before inventory/provider deletion", async () => {
    mocks.neonLookup.mockResolvedValue({ kind: "found", projectIds: ["neon-delayed"] });
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 77,
            owner_id: "fixture-owner",
            name: "Fixture",
            deleted_at: new Date("2026-09-01T00:00:00.000Z"),
            db_provider: "postgres",
            db_status: "error",
            neon_project_id: null,
            db_connection_id: null,
            retirement_operation_id: "retirement-77",
            retirement_state: "completed",
            retirement_completed_at: new Date("2026-09-01T00:00:00.000Z"),
            retirement_progress: {},
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 77 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ active_count: 0 }] });
    await expect(inventoryProjectPurgeResources(77)).resolves.toMatchObject({
      neonProjectIds: ["neon-delayed"],
    });
    const update = mocks.poolQuery.mock.calls[2];
    expect(update?.[0]).toContain("deleted_at=$4");
    expect(update?.[0]).toContain("neon_project_id IS NULL AND db_connection_id IS NULL");
    expect(update?.[1]).toEqual([
      77,
      "neon-delayed",
      "fixture-owner",
      expect.any(Date),
      "postgres",
      "error",
    ]);
    expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
  });

  it("retains an unresolved intent at the final relational boundary even with an old provider-complete checkpoint", async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    const client = relationalClient({ leaseVersion: 4, unresolvedNeon: true });
    mocks.poolConnect.mockResolvedValueOnce(client);
    await expect(
      applyProjectRelationalPurge(77, "operation-77", {
        inventoryDigestSha256: "a".repeat(64),
        providerRemoved: 2,
        providerDetached: 0,
        leaseVersion: 4,
      }),
    ).rejects.toThrow("project_purge_neon_allocation_unresolved");
    const statements = client.statements.map(({ sql }) => sql);
    expect(statements.some((sql) => sql.startsWith("DELETE "))).toBe(false);
    expect(statements.some((sql) => sql.includes("SET state='completed'"))).toBe(false);
    expect(statements).toContain("ROLLBACK");
  });

  it.each(["provisioning", "error", "ready"])(
    "blocks legacy preview %s inventory before any resource mutation",
    async (status) => {
      mocks.previewReconcile.mockResolvedValue(null);
      mocks.poolQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 77,
              owner_id: "fixture-owner",
              name: "Fixture",
              deleted_at: new Date("2026-09-01T00:00:00.000Z"),
              db_provider: "none",
              db_status: "none",
              neon_project_id: null,
              db_connection_id: null,
              preview_db_status: status,
              preview_db_has_url: status === "ready",
              preview_db_allocation: null,
              retirement_operation_id: "retirement-77",
              retirement_state: "completed",
              retirement_completed_at: new Date("2026-09-01T00:00:00.000Z"),
              retirement_progress: {},
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ id: "purge-77", lease_version: 7 }] });
      await expect(inventoryProjectPurgeResources(77)).rejects.toThrow(
        "project_purge_preview_allocation_unresolved",
      );
      expect(mocks.poolQuery).toHaveBeenCalledTimes(3);
      expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
      expect(mocks.deleteSnapshotBlob).not.toHaveBeenCalled();
    },
  );

  it("requires the captured purge lease and receipt CAS to persist recovered preview ownership", async () => {
    const allocation: PreviewDatabaseAllocationReceipt = {
      version: 1,
      projectId: 77,
      allocationId: "00000000-0000-4000-8000-000000000077",
      organizationId: "org-fixture",
      regionId: "aws-us-east-1",
      provenance: "single-dispatch",
      providerProjectId: null,
    };
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 77,
            owner_id: "fixture-owner",
            name: "Fixture",
            deleted_at: new Date("2026-09-01T00:00:00.000Z"),
            db_provider: "none",
            db_status: "none",
            neon_project_id: null,
            db_connection_id: null,
            preview_db_status: "error",
            preview_db_has_url: false,
            preview_db_allocation: allocation,
            retirement_operation_id: "retirement-77",
            retirement_state: "completed",
            retirement_completed_at: new Date("2026-09-01T00:00:00.000Z"),
            retirement_progress: {},
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: "purge-77", lease_version: 7 }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mocks.previewReconcile.mockImplementation(async ({ recordReceipt }) => {
      const next = { ...allocation, providerProjectId: "neon-delayed-preview" };
      if (!(await recordReceipt(allocation, next))) {
        throw new Error("project_purge_preview_allocation_unresolved");
      }
      return next;
    });
    await expect(inventoryProjectPurgeResources(77)).rejects.toThrow(
      "project_purge_preview_allocation_unresolved",
    );
    const [sql, values] = mocks.poolQuery.mock.calls[3]!;
    expect(sql).toContain("preview_db_allocation IS NOT DISTINCT FROM $7::jsonb");
    expect(sql).toContain("lease_version=$9 AND lease_expires_at>NOW()");
    expect(values.slice(-2)).toEqual(["purge-77", 7]);
    expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
  });

  it.each(["old-checkpoint", "pending-preview", "receipt-changed"])(
    "blocks final deletion for %s even when the database checkpoint was complete",
    async (scenario) => {
      const preview: PreviewDatabaseState = {
        status: "error",
        hasCredential: false,
        allocation: {
          version: 1,
          projectId: 77,
          allocationId: "00000000-0000-4000-8000-000000000077",
          organizationId: "org-fixture",
          regionId: "aws-us-east-1",
          provenance: "single-dispatch",
          providerProjectId: scenario === "pending-preview" ? null : "neon-preview-77",
        },
      };
      mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
      const client = relationalClient({
        leaseVersion: 4,
        legacyPreviewCheckpoint: scenario === "old-checkpoint",
        ...(scenario === "old-checkpoint" ? {} : { preview }),
      });
      mocks.poolConnect.mockResolvedValueOnce(client);
      await expect(
        applyProjectRelationalPurge(77, "operation-77", {
          inventoryDigestSha256: "a".repeat(64),
          providerRemoved: 0,
          providerDetached: 0,
          leaseVersion: 4,
        }),
      ).rejects.toThrow("project_purge_preview_allocation_unresolved");
      expect(client.statements.some(({ sql }) => sql.startsWith("DELETE "))).toBe(false);
      expect(client.statements.map(({ sql }) => sql)).toContain("ROLLBACK");
    },
  );

  it("rejects a superseded lease before the final preview or row-delete boundary", async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    const client = relationalClient({ leaseVersion: 5 });
    mocks.poolConnect.mockResolvedValueOnce(client);
    await expect(
      applyProjectRelationalPurge(77, "operation-77", {
        inventoryDigestSha256: "a".repeat(64),
        providerRemoved: 0,
        providerDetached: 0,
        leaseVersion: 4,
      }),
    ).rejects.toThrow("project_purge_operation_conflict");
    expect(client.statements.some(({ sql }) => sql.startsWith("DELETE "))).toBe(false);
  });

  it("preserves every shared R2 object and deletes only final references", async () => {
    mocks.deleteAssetObject.mockResolvedValue(undefined);
    mocks.headAssetObject.mockResolvedValue(null);
    const input = inventory({
      assetTargets: [
        {
          assetId: 1,
          ownerUserId: "owner-user",
          shared: true,
          storageBackend: "r2",
          storageKey: "accounts/owner/shared.webp",
          sizeBytes: 10,
        },
        {
          assetId: 2,
          ownerUserId: "owner-user",
          shared: false,
          storageBackend: "r2",
          storageKey: "accounts/owner/owned.webp",
          sizeBytes: 20,
        },
      ],
      legacyGeneratedImageTargets: [
        { storageBackend: "r2", storageKey: "legacy/shared.webp", shared: true },
        { storageBackend: "r2", storageKey: "legacy/owned.webp", shared: false },
      ],
    });
    mocks.poolConnect
      .mockReset()
      .mockResolvedValueOnce(assetClaimClient(true))
      .mockResolvedValueOnce(assetClaimClient(false))
      .mockResolvedValueOnce(assetClaimClient(true))
      .mockResolvedValueOnce(assetClaimClient(false));

    await expect(releaseProjectAssetStorage(input)).resolves.toMatchObject({
      deletedObjects: 2,
      detachedObjects: 2,
      complete: true,
    });
    expect(mocks.deleteAssetObject.mock.calls.map(([key]) => key)).toEqual([
      "accounts/owner/owned.webp",
      "legacy/owned.webp",
    ]);
    expect(mocks.deleteAssetObject.mock.calls.flat()).not.toContain("accounts/owner/shared.webp");
    expect(mocks.deleteAssetObject.mock.calls.flat()).not.toContain("legacy/shared.webp");
  });

  it("locks and rechecks a formerly unshared asset before physical deletion", async () => {
    const claim = assetClaimClient(true);
    mocks.poolConnect.mockResolvedValueOnce(claim);
    const input = inventory({
      assetTargets: [
        {
          assetId: 2,
          ownerUserId: "owner-user",
          shared: false,
          storageBackend: "r2",
          storageKey: "accounts/owner/newly-shared.webp",
          sizeBytes: 20,
        },
      ],
    });

    await expect(releaseProjectAssetStorage(input)).resolves.toMatchObject({
      deletedObjects: 0,
      detachedObjects: 1,
      complete: true,
    });
    const sql = claim.statements.map((entry) => entry.sql);
    expect(sql.findIndex((statement) => statement.includes("FOR UPDATE"))).toBeLessThan(
      sql.findIndex((statement) => statement.includes("durable_asset_reference_exists")),
    );
    expect(sql).toContain("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(sql.some((statement) => statement.includes("UPDATE assets SET state='deleting'"))).toBe(
      false,
    );
    expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
  });

  it("locks and preserves every object when only a secondary R2 object is referenced", async () => {
    const fullKey = "assets/owner/image/00000000-0000-4000-8000-000000000051/full.webp";
    const thumbnailKey = "assets/owner/image/00000000-0000-4000-8000-000000000051/thumb.webp";
    const options = {
      storageKeys: [fullKey, thumbnailKey],
      rawSharedKeys: [thumbnailKey],
    };
    const fullClaim = assetClaimClient(false, "ready", [], options);
    const thumbnailClaim = assetClaimClient(false, "ready", [], options);
    mocks.poolConnect
      .mockReset()
      .mockResolvedValueOnce(fullClaim)
      .mockResolvedValueOnce(thumbnailClaim);

    await expect(
      releaseProjectAssetStorage(
        inventory({
          assetTargets: [
            {
              assetId: 51,
              ownerUserId: "owner-user",
              shared: false,
              storageBackend: "r2",
              storageKey: fullKey,
              sizeBytes: 20,
            },
            {
              assetId: 51,
              ownerUserId: "owner-user",
              shared: false,
              storageBackend: "r2",
              storageKey: thumbnailKey,
              sizeBytes: 5,
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({ deletedObjects: 0, detachedObjects: 2, complete: true });
    expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
    for (const claim of [fullClaim, thumbnailClaim]) {
      const locks = claim.statements
        .filter((entry) => entry.sql.includes("pg_advisory_xact_lock"))
        .map((entry) => entry.values[0]);
      expect(locks).toEqual([fullKey, thumbnailKey]);
      const checks = claim.statements
        .filter(
          (entry) =>
            entry.sql.endsWith(") AS shared") &&
            !entry.sql.includes("public.durable_asset_reference_exists"),
        )
        .map((entry) => entry.values[1]);
      expect(checks).toEqual([fullKey, thumbnailKey]);
      const marker = claim.statements.find((entry) =>
        entry.sql.startsWith("INSERT INTO asset_usage"),
      );
      expect(marker?.sql).toContain("'project-purge-preserved-direct:' || $2::text");
      expect(marker?.values).toEqual([51, 51]);
    }
  });

  it("keeps purge preservation markers retry-stable, temporary, and delimiter-safe", () => {
    const source = readFileSync(new URL("./project-purge-resources.ts", import.meta.url), "utf8");
    expect(source).toContain(
      "usage_row.consumer IS DISTINCT FROM\n                     'project-purge-preserved-direct:' || $1::text",
    );
    expect(source).toContain("OR consumer='project-purge-preserved-direct:' || $1::text");

    const migration = readFileSync(new URL("./startup-migrations.ts", import.meta.url), "utf8");
    const tokenDefinition = migration
      .split("\n")
      .find((line) => line.includes("const durableStorageKeyToken ="));
    expect(migration.match(/const durableStorageKeyToken =/gu)).toHaveLength(1);
    expect(migration.match(/\$\{durableStorageKeyToken\}/gu)).toHaveLength(2);
    expect(tokenDefinition).toContain("\'\'");
    expect(tokenDefinition).toContain("[:space:]");
    expect(tokenDefinition).toContain("?#<>(){},;" + String.fromCharCode(96) + "]+");
    expect(migration).toContain("FROM candidate_keys candidate_key");
    expect(migration).toContain("'project-purge-preserved-direct:' || excluded_project_id::text");
    expect(migration).toContain(
      "SET consumer='project-purge-preserved-direct:' || asset_row.project_id::text",
    );
    expect(migration).toContain("legacy_usage.consumer='project-purge-preserved-direct'");
  });

  it("derives isolated deterministic R2 keys and preserves crash-recovery evidence", () => {
    const first = projectPurgeLegacyMigrationTargetKey({
      assetId: 19,
      ownerUserId: "owner-a",
      sourceKey: "/objects/uploads/legacy-a",
      filename: "../../unsafe image.webp",
    });
    expect(first).toMatch(
      /^assets\/[a-f0-9]{24}\/account\/[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/unsafe-image\.webp$/u,
    );
    expect(
      projectPurgeLegacyMigrationTargetKey({
        assetId: 19,
        ownerUserId: "owner-a",
        sourceKey: "/objects/uploads/legacy-a",
        filename: "../../unsafe image.webp",
      }),
    ).toBe(first);
    expect(
      projectPurgeLegacyMigrationTargetKey({
        assetId: 19,
        ownerUserId: "owner-b",
        sourceKey: "/objects/uploads/legacy-a",
        filename: "../../unsafe image.webp",
      }),
    ).not.toBe(first);

    const source = readFileSync(new URL("./project-purge-resources.ts", import.meta.url), "utf8");
    expect(source).toContain(
      'const LEGACY_MIGRATION_TARGET_ROLE_PREFIX = "project-purge-r2-target:"',
    );
    expect(source).toContain(
      'const LEGACY_MIGRATION_SOURCE_ROLE_PREFIX = "project-purge-legacy-source:"',
    );
    expect(source).toContain("'project-purge-migration'");
    expect(source).toContain("inventoryStorageBackend ?? target.storageBackend");
    expect(source).toContain("project_purge_asset_storage_migration_hash_mismatch");
    expect(source).toContain("project_purge_asset_storage_migration_ambiguous");
    expect(source).toContain(
      "await deleteLegacyObjectAndProveAbsent(plan.sourceKey, signal, plan.sourceGeneration)",
    );
  });

  it("preserves a rewritten legacy generation and its committed deletion claim", async () => {
    const digest = "a".repeat(64);
    const sourceKey = "/objects/uploads/legacy-generation-race";
    const targetKey = "assets/owner/account/00000000-0000-5000-8000-000000000051/file.bin";
    const client = legacyMigrationClient({ digest, sourceKey, targetKey });
    const provider = legacyProviderFixture(true);
    mocks.poolConnect.mockReset().mockResolvedValue(client);

    await expect(
      migrateRetainedLegacyAssetsForPurge(
        inventory({
          assetTargets: [
            {
              assetId: 2,
              ownerUserId: "owner-user",
              shared: true,
              storageBackend: "legacy-object",
              storageKey: sourceKey,
              storageObjectId: 11,
              sizeBytes: Buffer.byteLength("legacy-provider-object"),
              filename: "file.bin",
              mimeType: "application/octet-stream",
              migrationTargetObjectId: 12,
              migrationTargetKey: targetKey,
              migrationTargetRole: `project-purge-r2-target:${digest}`,
            },
          ],
        }),
      ),
    ).rejects.toThrow("conditionNotMet");
    expect(provider.deleteFile).toHaveBeenCalledTimes(1);
    expect(provider.deleteFile).toHaveBeenCalledWith({
      ignoreNotFound: true,
      ifGenerationMatch: "1",
    });
    expect(provider.currentGeneration()).toBe("2");
    expect(provider.deleted()).toBe(false);
    expect(client.sourceRole()).toBe(`project-purge-legacy-source:${digest}:1`);
    expect(client.claimPresent()).toBe(true);
    expect(client.sourceDeleted()).toBe(false);
  });

  it("deletes exactly the verified stable legacy generation", async () => {
    const digest = "a".repeat(64);
    const sourceKey = "/objects/uploads/legacy-generation-stable";
    const targetKey = "assets/owner/account/00000000-0000-5000-8000-000000000052/file.bin";
    const client = legacyMigrationClient({ digest, sourceKey, targetKey });
    const provider = legacyProviderFixture(false);
    mocks.poolConnect.mockReset().mockResolvedValue(client);

    await expect(
      migrateRetainedLegacyAssetsForPurge(
        inventory({
          assetTargets: [
            {
              assetId: 2,
              ownerUserId: "owner-user",
              shared: true,
              storageBackend: "legacy-object",
              storageKey: sourceKey,
              storageObjectId: 11,
              sizeBytes: Buffer.byteLength("legacy-provider-object"),
              filename: "file.bin",
              mimeType: "application/octet-stream",
              migrationTargetObjectId: 12,
              migrationTargetKey: targetKey,
              migrationTargetRole: `project-purge-r2-target:${digest}`,
            },
          ],
        }),
      ),
    ).resolves.toBe(true);
    expect(provider.deleteFile).toHaveBeenCalledTimes(1);
    expect(provider.deleteFile).toHaveBeenCalledWith({
      ignoreNotFound: true,
      ifGenerationMatch: "1",
    });
    expect(provider.currentGeneration()).toBe("1");
    expect(provider.deleted()).toBe(true);
    expect(client.sourceRole()).toBe(`project-purge-legacy-source:${digest}:1`);
    expect(client.claimPresent()).toBe(false);
    expect(client.sourceDeleted()).toBe(true);
  });

  it("keeps unsupported retained legacy delivery intact before physical release", async () => {
    const alias = "/api/projects/51/uploads/7/content";
    const claim = assetClaimClient(true, "ready", [alias], { storageBackend: "legacy-object" });
    mocks.poolConnect.mockResolvedValueOnce(claim);
    await expect(
      releaseProjectAssetStorage(
        inventory({
          assetTargets: [
            {
              assetId: 2,
              ownerUserId: "owner-user",
              shared: false,
              storageBackend: "legacy-object",
              storageKey: "/objects/uploads/00000000-0000-4000-8000-000000000007",
              sizeBytes: 1,
            },
          ],
        }),
      ),
    ).rejects.toThrow("project_purge_asset_storage_migration_required");
    expect(claim.statements.some(({ sql }) => /^(UPDATE|DELETE|INSERT) /u.test(sql))).toBe(false);
    expect(claim.statements.map(({ sql }) => sql)).toContain("ROLLBACK");
    expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
    expect(mocks.getLegacyObject).not.toHaveBeenCalled();
  });

  it("rolls back final purge without remapping a retained non-R2 legacy alias", async () => {
    const alias = "/api/projects/77/uploads/82/content";
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    const client = relationalClient({
      leaseVersion: 4,
      finalReferenced: true,
      finalRawSharedKeys: [alias],
      finalAssets: [
        {
          id: 19,
          project_id: 77,
          state: "ready",
          storage_key: "legacy/key",
          product_scope: "nabuflow",
          storage_backend: "legacy-object",
        },
      ],
      finalAliases: [{ kind: "upload", id: 82, alias, asset_id: 19, storage_key: "legacy/key" }],
    });
    mocks.poolConnect.mockResolvedValueOnce(client);
    await expect(
      applyProjectRelationalPurge(77, "operation-77", {
        inventoryDigestSha256: "a".repeat(64),
        providerRemoved: 0,
        providerDetached: 0,
        leaseVersion: 4,
      }),
    ).rejects.toThrow("project_purge_asset_storage_migration_required");
    expect(client.statements.some(({ sql }) => /^(UPDATE|DELETE|INSERT) /u.test(sql))).toBe(false);
    expect(client.statements.map(({ sql }) => sql)).toContain("ROLLBACK");
    expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
    expect(mocks.getLegacyObject).not.toHaveBeenCalled();
  });

  it("canonicalizes every surviving legacy alias before source metadata can disappear", async () => {
    const claim = assetClaimClient(true, "ready", [
      "/api/images/91/file",
      "/api/projects/51/uploads/7/content",
    ]);
    mocks.poolConnect.mockResolvedValueOnce(claim);
    const input = inventory({
      assetTargets: [
        {
          assetId: 2,
          ownerUserId: "owner-user",
          shared: false,
          storageBackend: "r2",
          storageKey: "accounts/owner/alias.webp",
          sizeBytes: 20,
        },
      ],
    });

    await expect(releaseProjectAssetStorage(input)).resolves.toMatchObject({
      deletedObjects: 0,
      detachedObjects: 1,
    });
    const updates = claim.statements.filter((entry) => entry.sql.startsWith("UPDATE "));
    for (const table of [
      "chat_messages",
      "agent_tasks",
      "agent_tool_calls",
      "zero_prompt_queue_items",
      "knowledge_entries",
      "project_files",
      "project_versions",
      "canvas_variants",
      "canvas_variant_library",
      "gallery_templates",
      "agent_inbox",
      "task_events",
      "project_activity",
      "visual_edit_changes",
      "generated_images",
    ]) {
      expect(updates.some((entry) => entry.sql.startsWith(`UPDATE ${table}`))).toBe(true);
    }
    const globalUpdates = updates.filter((entry) =>
      /^UPDATE (canvas_variant_library|gallery_templates) /u.test(entry.sql),
    );
    expect(globalUpdates).toHaveLength(4);
    for (const entry of globalUpdates) {
      expect(entry.values).toHaveLength(2);
      expect(entry.values[1]).toBe("/api/assets/2/content");
      expect(entry.sql).toContain("replace(");
      expect(entry.sql).toContain("$1, $2");
      expect(entry.sql).not.toContain("$3");
    }
    expect(
      updates
        .filter((entry) => !globalUpdates.includes(entry))
        .every((entry) => entry.values[2] === "/api/assets/2/content"),
    ).toBe(true);
    expect(updates.find((entry) => entry.sql.startsWith("UPDATE agent_tool_calls"))?.sql).toContain(
      "call_row.project_id IS DISTINCT FROM $1",
    );
    expect(
      updates.find((entry) => entry.sql.startsWith("UPDATE agent_tool_calls"))?.sql,
    ).not.toContain("task.id=call_row.task_id");
    expect(
      claim.statements.findIndex((entry) => entry.sql.includes("durable_asset_reference_exists")),
    ).toBeGreaterThan(
      claim.statements.findIndex((entry) => entry.sql.startsWith("UPDATE chat_messages")),
    );
  });

  it("makes a final-reference asset non-attachable before deleting its provider object", async () => {
    const claim = assetClaimClient(false);
    mocks.poolConnect.mockResolvedValueOnce(claim);
    mocks.deleteAssetObject.mockResolvedValue(undefined);
    mocks.headAssetObject.mockResolvedValue(null);

    await expect(
      releaseProjectAssetStorage(
        inventory({
          assetTargets: [
            {
              assetId: 2,
              ownerUserId: "owner-user",
              shared: false,
              storageBackend: "r2",
              storageKey: "accounts/owner/final.webp",
              sizeBytes: 20,
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({ deletedObjects: 1, detachedObjects: 0 });
    expect(claim.statements.map((entry) => entry.sql)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("FOR UPDATE"),
        expect.stringContaining("pg_advisory_xact_lock"),
        expect.stringContaining("UPDATE assets SET state='deleting'"),
        expect.stringContaining("UPDATE asset_storage_objects SET state='deleting'"),
        expect.stringContaining("INSERT INTO durable_asset_deletion_claims"),
      ]),
    );
    expect(mocks.deleteAssetObject).toHaveBeenCalledWith("accounts/owner/final.webp");
    const migration = readFileSync(new URL("./startup-migrations.ts", import.meta.url), "utf8");
    expect(migration).toContain("BEFORE INSERT OR UPDATE OF asset_id, project_id ON asset_usage");
  });

  it("does not treat a soft-deleted generated image as a surviving object reference", async () => {
    const key = "accounts/owner/soft-deleted-image.webp";
    const claim = assetClaimClient(false, "ready", [], { softDeletedImageKey: key });
    mocks.poolConnect.mockResolvedValueOnce(claim);
    mocks.deleteAssetObject.mockResolvedValue(undefined);
    mocks.headAssetObject.mockResolvedValue(null);

    await expect(
      releaseProjectAssetStorage(
        inventory({
          assetTargets: [
            {
              assetId: 2,
              ownerUserId: "owner-user",
              shared: true,
              storageBackend: "r2",
              storageKey: key,
              sizeBytes: 20,
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({ deletedObjects: 1, detachedObjects: 0 });
    expect(mocks.deleteAssetObject).toHaveBeenCalledTimes(1);
    expect(mocks.deleteAssetObject).toHaveBeenCalledWith(key);
    expect(
      claim.statements.find(({ sql, values }) => sql.endsWith(") AS shared") && values[1] === key)
        ?.sql,
    ).toContain("image_row.deleted_at IS NULL");
    expect(
      claim.statements.find(({ sql }) => sql.includes("/* purge-image-storage-aliases */"))?.sql,
    ).toContain("image.deleted_at IS NULL");
  });

  it("deletes a stale final preservation exactly once and moves its count once", async () => {
    const key = "accounts/owner/stale-preserved.webp";
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    const client = relationalClient({
      leaseVersion: 4,
      finalReferenceSequence: [false, false],
      preservedAssetIds: [19],
      finalAssets: [
        {
          id: 19,
          project_id: 77,
          state: "ready",
          storage_key: key,
          product_scope: "nabuflow",
        },
      ],
      finalStorage: [
        {
          id: 91,
          asset_id: 19,
          storage_key: key,
          state: "ready",
        },
      ],
      modelAssetRehome: true,
    });
    mocks.poolConnect.mockResolvedValueOnce(client);
    mocks.deleteAssetObject.mockResolvedValue(undefined);
    mocks.headAssetObject.mockResolvedValue(null);

    await expect(
      applyProjectRelationalPurge(77, "operation-77", {
        inventoryDigestSha256: "a".repeat(64),
        providerRemoved: 0,
        providerDetached: 1,
        leaseVersion: 4,
      }),
    ).resolves.toMatchObject({ removedResourceCount: 3, detachedResourceCount: 2 });
    expect(mocks.deleteAssetObject).toHaveBeenCalledTimes(1);
    expect(mocks.deleteAssetObject).toHaveBeenCalledWith(key);
    const terminal = client.statements.find(({ sql }) =>
      sql.startsWith("UPDATE project_purge_operations SET state='completed'"),
    );
    const evidence = JSON.parse(String(terminal?.values[2])) as {
      removedResourceCount: number;
      detachedResourceCount: number;
    };
    expect(evidence).toMatchObject({ removedResourceCount: 3, detachedResourceCount: 2 });
    const progressUpdates = client.statements.filter(({ sql }) =>
      sql.startsWith("UPDATE project_purge_operations SET resource_progress=$3::jsonb"),
    );
    const cursor = JSON.parse(String(progressUpdates.at(-1)?.values[2])).finalFenceReconciliation;
    expect(cursor.removedStorageKeys).toEqual([key]);
    expect(cursor.removedProviderDetachedStorageKeys).toEqual([key]);
    expect(cursor.latePreservedStorageKeys).toEqual([]);
  });

  it("keeps a stable final reference and rehomes and counts it exactly once", async () => {
    const key = "accounts/owner/stably-preserved.webp";
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    const client = relationalClient({
      leaseVersion: 4,
      finalReferenced: true,
      finalAssets: [
        {
          id: 19,
          project_id: 77,
          state: "ready",
          storage_key: key,
          product_scope: "nabuflow",
        },
      ],
      finalStorage: [
        {
          id: 91,
          asset_id: 19,
          storage_key: key,
          state: "ready",
        },
      ],
      modelAssetRehome: true,
    });
    mocks.poolConnect.mockResolvedValueOnce(client);

    await expect(
      applyProjectRelationalPurge(77, "operation-77", {
        inventoryDigestSha256: "a".repeat(64),
        providerRemoved: 0,
        providerDetached: 0,
        leaseVersion: 4,
      }),
    ).resolves.toMatchObject({ removedResourceCount: 2, detachedResourceCount: 4 });
    expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
    expect(
      client.statements.filter(({ sql }) =>
        sql.startsWith("UPDATE assets asset_row SET project_id=NULL"),
      ),
    ).toHaveLength(1);
    const progress = client.statements.find(({ sql }) =>
      sql.startsWith("UPDATE project_purge_operations SET resource_progress=$3::jsonb"),
    );
    const cursor = JSON.parse(String(progress?.values[2])).finalFenceReconciliation;
    expect(cursor.removedStorageKeys).toEqual([]);
    expect(cursor.removedProviderDetachedStorageKeys).toEqual([]);
    expect(cursor.latePreservedStorageKeys).toEqual([key]);
  });

  it.each(["reserved", "uploading", "rejected"])(
    "cleans an incomplete %s asset instead of trapping the project in Trash",
    async (state) => {
      const claim = assetClaimClient(false, state);
      mocks.poolConnect.mockResolvedValueOnce(claim);
      mocks.deleteAssetObject.mockResolvedValue(undefined);
      mocks.headAssetObject.mockResolvedValue(null);

      await expect(
        releaseProjectAssetStorage(
          inventory({
            assetTargets: [
              {
                assetId: 3,
                ownerUserId: "owner-user",
                shared: false,
                storageBackend: "r2",
                storageKey: `accounts/owner/${state}.webp`,
                sizeBytes: 20,
              },
            ],
          }),
        ),
      ).resolves.toMatchObject({ deletedObjects: 1, complete: true });
    },
  );

  it("never deletes a legacy upload object while a durable shared reference survives", async () => {
    const input = inventory({
      uploadTargets: [{ objectPath: "/objects/shared-upload", shared: true }],
    });

    mocks.poolConnect.mockResolvedValueOnce(assetClaimClient(true));
    await expect(releaseProjectAssetStorage(input)).resolves.toMatchObject({
      deletedObjects: 0,
      detachedObjects: 1,
      complete: true,
    });
    expect(mocks.getLegacyObject).not.toHaveBeenCalled();
  });

  it("rechecks legacy and snapshot keys immediately before every physical delete", async () => {
    const legacyClaim = assetClaimClient(true);
    const uploadClaim = assetClaimClient(true);
    const snapshotClaim = assetClaimClient(true);
    mocks.poolConnect
      .mockReset()
      .mockResolvedValueOnce(legacyClaim)
      .mockResolvedValueOnce(uploadClaim)
      .mockResolvedValueOnce(snapshotClaim);
    const input = inventory({
      legacyGeneratedImageTargets: [
        { storageBackend: "r2", storageKey: "legacy/new-reference.webp", shared: false },
      ],
      uploadTargets: [{ objectPath: "/objects/new-reference", shared: false }],
      snapshotObjectKeys: ["db-snapshots/51/new-reference.sql"],
    });

    await expect(releaseProjectAssetStorage(input)).resolves.toMatchObject({
      deletedObjects: 0,
      detachedObjects: 2,
      complete: true,
    });
    await expect(releaseProjectSnapshotStorage(input)).resolves.toMatchObject({
      removed: 0,
      detached: 1,
      complete: true,
    });
    expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
    expect(mocks.getLegacyObject).not.toHaveBeenCalled();
    expect(mocks.deleteSnapshotBlob).not.toHaveBeenCalled();
    for (const claim of [legacyClaim, uploadClaim, snapshotClaim]) {
      const sql = claim.statements.map((entry) => entry.sql);
      expect(
        sql.findIndex((statement) => statement.includes("pg_advisory_xact_lock")),
      ).toBeLessThan(sql.findIndex((statement) => statement.endsWith(") AS shared")));
      expect(
        sql.some((statement) => statement.includes("INSERT INTO durable_asset_deletion_claims")),
      ).toBe(false);
      expect(sql.at(-1)).toBe("COMMIT");
    }
    const referenceSql = legacyClaim.statements.find((entry) =>
      entry.sql.endsWith(") AS shared"),
    )?.sql;
    expect(referenceSql).toContain("asset_storage_objects");
    expect(referenceSql).toContain("project_uploads");
    expect(referenceSql).toContain("project_files");
    expect(referenceSql).toContain("project_versions");
    expect(referenceSql).toContain("chat_messages");
    expect(referenceSql).toContain("agent_tasks");
    expect(referenceSql).toContain("agent_tool_calls");
    expect(referenceSql).toContain("call_row.project_id");
    expect(referenceSql).toContain("zero_prompt_queue_items");
    expect(referenceSql).toContain("knowledge_entries");
    expect(referenceSql).toContain("canvas_variant_library");
    expect(referenceSql).toContain("gallery_templates");
    expect(referenceSql).toContain("visual_edit_changes");
    expect(referenceSql).toContain("generated_images");
    expect(referenceSql).toContain("db_snapshots");
  });

  it("bounds each provider pass and resumes exactly after its durable cursor", async () => {
    const input = inventory({
      assetTargets: Array.from({ length: 30 }, (_, index) => ({
        assetId: index + 1,
        ownerUserId: "owner-user",
        shared: true,
        storageBackend: "r2",
        storageKey: `accounts/owner/shared-${index + 1}.webp`,
        sizeBytes: 1,
      })),
    });

    mocks.poolConnect.mockImplementation(async () => assetClaimClient(true));
    const first = await releaseProjectAssetStorage(input);
    expect(first).toMatchObject({
      deletedObjects: 0,
      detachedObjects: 25,
      cursor: { assetIndex: 25, legacyImageIndex: 0, uploadIndex: 0 },
      complete: false,
    });
    const second = await releaseProjectAssetStorage(input, first.cursor);
    expect(second).toMatchObject({
      deletedObjects: 0,
      detachedObjects: 5,
      cursor: { assetIndex: 30, legacyImageIndex: 0, uploadIndex: 0 },
      complete: true,
    });
    expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
  });

  it("fails closed instead of accepting a cursor that could skip a resource", async () => {
    const input = inventory({
      uploadTargets: [{ objectPath: "/objects/owned-upload", shared: false }],
      snapshotObjectKeys: ["db-snapshots/51/one.sql"],
    });
    await expect(
      releaseProjectAssetStorage(input, {
        assetIndex: 0,
        legacyImageIndex: 0,
        uploadIndex: 2,
      }),
    ).rejects.toThrow("project_purge_asset_release_failed");
    await expect(releaseProjectSnapshotStorage(input, { snapshotIndex: 2 })).rejects.toThrow(
      "project_purge_snapshot_release_failed",
    );
    expect(mocks.getLegacyObject).not.toHaveBeenCalled();
    expect(mocks.deleteSnapshotBlob).not.toHaveBeenCalled();
  });

  it("fails without an R2 absence receipt and succeeds safely on retry", async () => {
    mocks.deleteAssetObject.mockResolvedValue(undefined);
    mocks.headAssetObject.mockResolvedValueOnce({ sizeBytes: 20 }).mockResolvedValueOnce(null);
    const input = inventory({
      assetTargets: [
        {
          assetId: 2,
          ownerUserId: "owner-user",
          shared: false,
          storageBackend: "r2",
          storageKey: "accounts/owner/owned.webp",
          sizeBytes: 20,
        },
      ],
    });

    await expect(releaseProjectAssetStorage(input)).rejects.toThrow(
      "project_purge_asset_release_failed",
    );
    await expect(releaseProjectAssetStorage(input)).resolves.toMatchObject({
      deletedObjects: 1,
      detachedObjects: 0,
      complete: true,
    });
    expect(mocks.deleteAssetObject).toHaveBeenCalledTimes(2);
  });

  it("requires snapshot absence and makes a failed attempt retry-safe", async () => {
    mocks.deleteSnapshotBlob.mockResolvedValue(true);
    mocks.snapshotBlobExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const input = inventory({ snapshotObjectKeys: ["db-snapshots/51/one.sql"] });

    await expect(releaseProjectSnapshotStorage(input)).rejects.toThrow(
      "project_purge_snapshot_release_failed",
    );
    await expect(releaseProjectSnapshotStorage(input)).resolves.toMatchObject({
      removed: 1,
      complete: true,
    });
    expect(mocks.deleteSnapshotBlob).toHaveBeenCalledTimes(2);
  });

  it.each([
    "missing",
    "fresh",
    "authorized",
    "wrong-project",
    "wrong-allocation",
    "invalid-epoch",
    "invalid-birth",
    "invalid-seal",
    "missing-seal",
    "invalid-birth-registration",
  ] as const)("blocks every relational DELETE for %s admission evidence", async (scenario) => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [productionDatabaseAdmissionCatalogRow] });
    let admission: Record<string, unknown> | null = {};
    switch (scenario) {
      case "missing":
        admission = null;
        break;
      case "fresh":
        admission = {
          state: "fresh",
          birth_registered: true,
          allocation_identity: null,
          seal_id: null,
        };
        break;
      case "authorized":
        admission = { state: "authorized", seal_id: null };
        break;
      case "wrong-project":
        admission = { project_id: 52 };
        break;
      case "wrong-allocation":
        admission = { allocation_identity: (await sealedAdmissionRow(52)).allocation_identity };
        break;
      case "invalid-epoch":
        admission = { registration_epoch: "not-a-uuid" };
        break;
      case "invalid-birth":
        admission = { birth_token: "not-a-uuid" };
        break;
      case "invalid-seal":
        admission = { seal_id: "not-a-uuid" };
        break;
      case "missing-seal":
        admission = { seal_id: null };
        break;
      case "invalid-birth-registration":
        admission = { birth_registered: "false" };
        break;
    }
    const client = relationalClient({ leaseVersion: 4, admission });
    mocks.poolConnect.mockResolvedValueOnce(client);
    await expect(
      applyProjectRelationalPurge(51, "operation-51", {
        inventoryDigestSha256: "a".repeat(64),
        providerRemoved: 0,
        providerDetached: 0,
        leaseVersion: 4,
      }),
    ).rejects.toThrow("project_purge_production_database_admission_unverified");
    const statements = client.statements.map(({ sql }) => sql);
    expect(statements.some((sql) => sql.startsWith("DELETE "))).toBe(false);
    expect(statements.some((sql) => sql.includes("SET state='completed'"))).toBe(false);
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(mocks.neonLookup).not.toHaveBeenCalled();
    expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
    expect(mocks.deleteSnapshotBlob).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "retains sealed admission with birth_registered=%s through final absence",
    async (birthRegistered) => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [productionDatabaseAdmissionCatalogRow] });
      const client = relationalClient({
        leaseVersion: 4,
        admission: { birth_registered: birthRegistered },
      });
      mocks.poolConnect.mockResolvedValueOnce(client);
      const result = await applyProjectRelationalPurge(51, "operation-51", {
        inventoryDigestSha256: "a".repeat(64),
        providerRemoved: 0,
        providerDetached: 0,
        leaseVersion: 4,
      });
      const statements = client.statements.map(({ sql }) => sql);
      const admissionReads = statements
        .map((sql, index) => ({ sql, index }))
        .filter(({ sql }) => sql.includes("FROM production_database_admission_receipts"));
      const projectDeleteIndex = statements.indexOf("DELETE FROM projects WHERE id=$1");
      const firstDeleteIndex = statements.findIndex((sql) => sql.startsWith("DELETE "));
      expect(admissionReads).toHaveLength(2);
      expect(
        admissionReads.every(({ sql }) => sql.endsWith("WHERE project_id=$1 FOR UPDATE")),
      ).toBe(true);
      expect(admissionReads[0]!.index).toBeLessThan(firstDeleteIndex);
      expect(admissionReads[1]!.index).toBeGreaterThan(projectDeleteIndex);
      expect(
        statements.some((sql) =>
          /^(DELETE FROM|UPDATE) production_database_admission_receipts\b/u.test(sql),
        ),
      ).toBe(false);
      expect(
        statements.some(
          (sql) =>
            sql.includes("COUNT(*)") && sql.includes("production_database_admission_receipts"),
        ),
      ).toBe(false);
      expect(statements).toContain("COMMIT");
      const terminal = client.statements.find(({ sql }) =>
        sql.startsWith("UPDATE project_purge_operations SET state='completed'"),
      );
      const evidence = JSON.parse(String(terminal?.values[2]));
      expect(evidence.absenceDigestSha256).toBe(result.absenceDigestSha256);
      expect(Object.keys(evidence).sort()).toEqual([
        "absenceDigestSha256",
        "detachedResourceCount",
        "inventoryDigestSha256",
        "outcome",
        "removedResourceCount",
        "schema",
      ]);
      expect(mocks.neonLookup).not.toHaveBeenCalled();
      expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
      expect(mocks.deleteSnapshotBlob).not.toHaveBeenCalled();
    },
  );

  it("binds the retained seal identity into the existing absence digest", async () => {
    const digests: string[] = [];
    for (const sealId of [
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000004",
    ]) {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [productionDatabaseAdmissionCatalogRow] });
      mocks.poolConnect.mockResolvedValueOnce(
        relationalClient({ leaseVersion: 4, admission: { seal_id: sealId } }),
      );
      const result = await applyProjectRelationalPurge(51, "operation-51", {
        inventoryDigestSha256: "a".repeat(64),
        providerRemoved: 0,
        providerDetached: 0,
        leaseVersion: 4,
      });
      digests.push(result.absenceDigestSha256);
    }
    expect(digests[0]).not.toBe(digests[1]);
  });

  it.each(["missing", "changed"] as const)(
    "refuses final absence when the retained admission is %s after project deletion",
    async (scenario) => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [productionDatabaseAdmissionCatalogRow] });
      const client = relationalClient({
        leaseVersion: 4,
        admissionAfterProjectDelete:
          scenario === "missing" ? null : { seal_id: "00000000-0000-4000-8000-000000000004" },
      });
      mocks.poolConnect.mockResolvedValueOnce(client);
      await expect(
        applyProjectRelationalPurge(51, "operation-51", {
          inventoryDigestSha256: "a".repeat(64),
          providerRemoved: 0,
          providerDetached: 0,
          leaseVersion: 4,
        }),
      ).rejects.toThrow(
        scenario === "missing"
          ? "project_purge_production_database_admission_unverified"
          : "project_purge_absence_unverified",
      );
      const statements = client.statements.map(({ sql }) => sql);
      expect(statements).toContain("DELETE FROM projects WHERE id=$1");
      expect(statements.some((sql) => sql.includes("SET state='completed'"))).toBe(false);
      expect(statements).toContain("ROLLBACK");
      expect(statements).not.toContain("COMMIT");
      expect(
        statements.some((sql) =>
          sql.startsWith("DELETE FROM production_database_admission_receipts"),
        ),
      ).toBe(false);
    },
  );

  it("rejects untrusted terminal counts and preserves only scrubbed purge notifications", async () => {
    await expect(
      applyProjectRelationalPurge(51, "operation-51", {
        inventoryDigestSha256: "not-a-digest",
        providerRemoved: 0,
        providerDetached: 0,
        leaseVersion: 1,
      }),
    ).rejects.toThrow("project_purge_relational_delete_failed");

    const source = readFileSync(new URL("./project-purge-resources.ts", import.meta.url), "utf8");
    expect(source).toContain("resource_type IS DISTINCT FROM 'project_purge'");
    expect(source).toContain("resource_type='project_purge'");
    expect(source).toContain("SET project_id=NULL");
    expect(source).toContain("title='Project deletion receipt'");
    expect(source).toContain("body='A project deletion milestone was recorded.'");
    const terminal = source.slice(source.indexOf("const terminalEvidence ="));
    expect(terminal).not.toContain("projectName");
    expect(terminal).not.toContain("ownerId");
    expect(terminal).not.toContain("storageKey");
  });

  it("detaches purchased domains, removes only local GitHub metadata, preserves the receipt, and proves zero references", async () => {
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [
        productionDatabaseAdmissionCatalogRow,
        {
          table_name: "project_github_connections",
          column_name: "project_id",
          delete_action: "no_fk",
          foreign_key_count: 0,
          referenced_table_schema: null,
          referenced_table_name: null,
          referenced_column_name: null,
        },
        {
          table_name: "purchased_domains",
          column_name: "project_id",
          delete_action: "no_fk",
          foreign_key_count: 0,
          referenced_table_schema: null,
          referenced_table_name: null,
          referenced_column_name: null,
        },
      ],
    });
    const client = relationalClient({ leaseVersion: 4 });
    mocks.poolConnect.mockResolvedValueOnce(client);

    await expect(
      applyProjectRelationalPurge(51, "operation-51", {
        inventoryDigestSha256: "a".repeat(64),
        providerRemoved: 3,
        providerDetached: 2,
        leaseVersion: 4,
      }),
    ).resolves.toMatchObject({ removedResourceCount: 5, detachedResourceCount: 4 });

    const sql = client.statements.map((entry) => entry.sql).join("\n");
    expect(sql).toContain("DELETE FROM project_github_connections WHERE project_id=$1");
    expect(sql).toContain("UPDATE purchased_domains SET project_id=NULL");
    expect(sql).not.toContain("DELETE FROM purchased_domains");
    expect(sql).not.toContain("DELETE FROM project_purge_operations");
    expect(sql).not.toContain("DELETE FROM production_database_admission_receipts");
    expect(sql).toContain("UPDATE project_purge_operations SET state='completed'");
    expect(sql).toContain("SELECT 1 FROM projects WHERE id=$1");
    const terminal = client.statements.find((entry) =>
      entry.sql.startsWith("UPDATE project_purge_operations SET state='completed'"),
    );
    expect(terminal?.values[3]).toBe(4);
    expect(String(terminal?.values[2])).not.toContain("Project 51");
    expect(String(terminal?.values[2])).not.toContain("owner-user");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("refuses relational deletion and terminalization when the worker lease is stale", async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    const client = relationalClient({ leaseVersion: 8 });
    mocks.poolConnect.mockResolvedValueOnce(client);

    await expect(
      applyProjectRelationalPurge(51, "operation-51", {
        inventoryDigestSha256: "a".repeat(64),
        providerRemoved: 0,
        providerDetached: 0,
        leaseVersion: 7,
      }),
    ).rejects.toThrow("project_purge_operation_conflict");
    const sql = client.statements.map((entry) => entry.sql).join("\n");
    expect(sql).not.toContain("DELETE FROM projects WHERE id=$1");
    expect(sql).not.toContain("SET state='completed'");
    expect(sql).toContain("ROLLBACK");
  });
});
