import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pool } from "@workspace/db";
import { canonicalAssetContentUrl, isProductScope } from "./asset-platform-scope";
import {
  productionDatabaseAllocationIdentity,
  productionDatabaseSealedAdmissionSchema,
} from "@workspace/tenant-runtime-contracts";
import type { PoolClient } from "pg";
import { deleteAssetObject, headAssetObject, openAsset, putAssetStream } from "./asset-r2";
import { ObjectNotFoundError, ObjectStorageService } from "./objectStorage";
import {
  hasCurrentProjectRetirementCompletionEvidence,
  PROJECT_LIFECYCLE_LOCK_NAMESPACE,
} from "./project-retirement-contract";
import { deleteSnapshotBlob, snapshotBlobExists } from "./snapshot-storage";
import {
  hasUnresolvedNeonAllocationIntent,
  reconcileNeonAllocationIntent,
} from "./neon-allocation-intent";
import {
  hasUnresolvedPreviewDatabaseAllocation,
  parsePreviewDatabaseAllocation,
  previewDatabaseEvidenceMatches,
  reconcilePreviewDatabaseAllocation,
  type PreviewDatabaseState,
} from "./preview-database-allocation";

export type ProjectReferenceDeleteAction = "cascade" | "set_null" | "restrict" | "no_fk";

export type ProjectReferenceCatalogRow = {
  tableName: string;
  columnName: "project_id" | "source_project_id";
  deleteAction: ProjectReferenceDeleteAction;
  foreignKeyCount: number;
  referencedTableSchema: string | null;
  referencedTableName: string | null;
  referencedColumnName: string | null;
};

export type ProjectReferencePolicy =
  | "delete"
  | "delete_via_parent"
  | "detach"
  | "preserve_receipt"
  | "other_product";

/**
 * Every project-shaped column that is not protected by ON DELETE CASCADE is
 * declared here. The live catalog is checked before provider deletion, so a
 * newly-added table cannot silently retain project data or block the final
 * transaction.
 */
export const PROJECT_REFERENCE_POLICIES: Readonly<
  Record<string, Readonly<Record<string, ProjectReferencePolicy>>>
> = {
  agent_inbox: { project_id: "delete" },
  credit_transactions: { project_id: "detach" },
  project_extensions: { project_id: "delete" },
  gallery_templates: { source_project_id: "detach" },
  generated_images: { project_id: "delete" },
  project_github_connections: { project_id: "delete" },
  knowledge_entries: { project_id: "delete" },
  nabuflow_usage_events: { project_id: "detach" },
  notifications: { project_id: "delete" },
  ora_conversations: { project_id: "other_product" },
  orax_audit_log: { project_id: "other_product" },
  orax_project_sources: { project_id: "other_product" },
  orax_threads: { project_id: "other_product" },
  orax_usage_events: { project_id: "other_product" },
  project_embeddings: { project_id: "delete" },
  production_database_admission_receipts: { project_id: "preserve_receipt" },
  project_purge_operations: { project_id: "preserve_receipt" },
  purchased_domains: { project_id: "detach" },
  support_grant_events: { project_id: "delete_via_parent" },
  support_user_deliveries: { project_id: "delete_via_parent" },
  support_tickets: { project_id: "delete" },
  webhook_deliveries: { project_id: "delete_via_parent" },
  canvas_variant_library: { source_project_id: "detach" },
  knowledge_provenance_events: { project_id: "detach" },
  support_access_grants: { project_id: "delete" },
  support_zero_sessions: { project_id: "delete" },
};

const ALLOWED_SET_NULL_REFERENCES = new Set([
  "canvas_variant_library.source_project_id",
  "knowledge_provenance_events.project_id",
]);
const ALLOWED_RESTRICT_REFERENCES = new Set([
  "support_access_grants.project_id",
  "support_zero_sessions.project_id",
]);

export type ProjectReferenceCatalogDecision =
  | { ok: true; rows: readonly ProjectReferenceCatalogRow[] }
  | { ok: false; unknown: readonly string[] };

export function validateProjectReferenceCatalog(
  rows: readonly ProjectReferenceCatalogRow[],
): ProjectReferenceCatalogDecision {
  const unknown: string[] = [];
  for (const row of rows) {
    const identity = `${row.tableName}.${row.columnName}`;
    const policy = PROJECT_REFERENCE_POLICIES[row.tableName]?.[row.columnName];
    if (policy === "other_product") continue;
    if (
      (row.foreignKeyCount === 0 &&
        (row.deleteAction !== "no_fk" ||
          row.referencedTableSchema !== null ||
          row.referencedTableName !== null ||
          row.referencedColumnName !== null)) ||
      (row.foreignKeyCount > 0 &&
        (row.foreignKeyCount !== 1 ||
          row.referencedTableSchema !== "public" ||
          row.referencedTableName !== "projects" ||
          row.referencedColumnName !== "id" ||
          row.deleteAction === "no_fk"))
    ) {
      unknown.push(identity);
      continue;
    }
    if (row.deleteAction === "cascade") continue;
    if (row.deleteAction === "set_null" && ALLOWED_SET_NULL_REFERENCES.has(identity)) continue;
    if (row.deleteAction === "restrict" && ALLOWED_RESTRICT_REFERENCES.has(identity)) continue;
    if (policy) continue;
    unknown.push(identity);
  }
  return unknown.length === 0
    ? { ok: true, rows }
    : { ok: false, unknown: [...new Set(unknown)].sort() };
}

export type ProjectAssetStorageTarget = {
  assetId: number;
  ownerUserId: string;
  shared: boolean;
  storageBackend: string;
  storageKey: string;
  sizeBytes: number;
  storageObjectId?: number;
  filename?: string;
  mimeType?: string;
  sha256?: string | null;
  inventoryStorageBackend?: string;
  inventoryStorageKey?: string;
  migrationSourceObjectId?: number | null;
  migrationSourceKey?: string | null;
  migrationSourceRole?: string | null;
  migrationSourceState?: string | null;
  migrationTargetObjectId?: number | null;
  migrationTargetKey?: string | null;
  migrationTargetRole?: string | null;
  migrationTargetState?: string | null;
};

export type LegacyGeneratedImageTarget = {
  storageKey: string;
  storageBackend: "r2" | "dev-file";
  shared: boolean;
};

export type LegacyProjectUploadTarget = {
  objectPath: string;
  shared: boolean;
};

export const PROJECT_PURGE_RESOURCE_BATCH_SIZE = 25 as const;

export type ProjectPurgeAssetReleaseCursor = {
  assetIndex: number;
  legacyImageIndex: number;
  uploadIndex: number;
};

export type ProjectPurgeSnapshotReleaseCursor = {
  snapshotIndex: number;
};

export type ProjectPurgeResourceInventory = {
  projectId: number;
  ownerId: string;
  projectName: string;
  deletedAt: Date;
  retirementOperationId: string;
  retirementProgress: unknown;
  neonProjectIds: string[];
  productionNeonProjectName: string;
  previewNeonProjectName: string;
  previewDatabase?: PreviewDatabaseState;
  assetTargets: ProjectAssetStorageTarget[];
  legacyGeneratedImageTargets: LegacyGeneratedImageTarget[];
  uploadTargets: LegacyProjectUploadTarget[];
  snapshotObjectKeys: string[];
  tableCounts: Array<{ tableName: string; columnName: string; rowCount: number }>;
  activeAddonCount: number;
  digestSha256: string;
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const LEGACY_MIGRATION_TARGET_ROLE_PREFIX = "project-purge-r2-target:";
const LEGACY_MIGRATION_SOURCE_ROLE_PREFIX = "project-purge-legacy-source:";
const LEGACY_STORAGE_PROVIDER_TIMEOUT_MS = 30_000;

type LegacyMigrationPlan = {
  projectId: number;
  assetId: number;
  ownerUserId: string;
  originDigest: string;
  sourceGeneration: string | null;
  sourceObjectId: number;
  sourceKey: string;
  targetObjectId: number;
  targetKey: string;
  filename: string;
  mimeType: string;
  expectedSha256: string | null;
};

type LegacyProviderObjectSnapshot = {
  sizeBytes: number;
  contentType: string;
  generation: string;
  checksum: string;
};

type LegacyProviderFile = Awaited<ReturnType<ObjectStorageService["getObjectEntityFile"]>>;

function migrationRoleDigest(role: string, prefix: string): string {
  const value = role.startsWith(prefix) ? role.slice(prefix.length) : "";
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("project_purge_asset_storage_migration_invalid");
  }
  return value;
}

function legacyMigrationSourceRole(originDigest: string, generation: string): string {
  if (!/^[a-f0-9]{64}$/u.test(originDigest) || !/^[0-9]+$/u.test(generation)) {
    throw new Error("project_purge_asset_storage_migration_invalid");
  }
  return `${LEGACY_MIGRATION_SOURCE_ROLE_PREFIX}${originDigest}:${generation}`;
}

function parseLegacyMigrationSourceRole(role: string): {
  originDigest: string;
  sourceGeneration: string;
} {
  const value = role.startsWith(LEGACY_MIGRATION_SOURCE_ROLE_PREFIX)
    ? role.slice(LEGACY_MIGRATION_SOURCE_ROLE_PREFIX.length)
    : "";
  const match = /^([a-f0-9]{64}):([0-9]+)$/u.exec(value);
  if (!match) {
    throw new Error("project_purge_asset_storage_migration_invalid");
  }
  return { originDigest: match[1], sourceGeneration: match[2] };
}

function safeMigratedFilename(value: string): string {
  const cleaned = basename(value)
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .slice(0, 120);
  return cleaned || "legacy-upload";
}

export function projectPurgeLegacyMigrationTargetKey(input: {
  assetId: number;
  ownerUserId: string;
  sourceKey: string;
  filename: string;
}): string {
  const tenant = createHash("sha256").update(input.ownerUserId).digest("hex").slice(0, 24);
  const seed = createHash("sha256")
    .update(
      ["nabuflow-project-purge-r2-v1", String(input.assetId), input.sourceKey].join(
        String.fromCharCode(0),
      ),
    )
    .digest("hex")
    .slice(0, 32)
    .split("");
  seed[12] = "5";
  seed[16] = (8 + (Number.parseInt(seed[16]!, 16) % 4)).toString(16);
  const objectId = [
    seed.slice(0, 8).join(""),
    seed.slice(8, 12).join(""),
    seed.slice(12, 16).join(""),
    seed.slice(16, 20).join(""),
    seed.slice(20, 32).join(""),
  ].join("-");
  return ["assets", tenant, "account", objectId, safeMigratedFilename(input.filename)].join("/");
}

async function withLegacyProviderDeadline<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(LEGACY_STORAGE_PROVIDER_TIMEOUT_MS);
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  bounded.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("project_purge_legacy_provider_timeout"));
    bounded.addEventListener("abort", onAbort, { once: true });
    void operation()
      .then(resolve, reject)
      .finally(() => {
        bounded.removeEventListener("abort", onAbort);
      });
  });
}

async function readLegacyProviderSnapshot(
  file: LegacyProviderFile,
  signal?: AbortSignal,
): Promise<LegacyProviderObjectSnapshot> {
  const [metadata] = await withLegacyProviderDeadline(() => file.getMetadata(), signal);
  const sizeBytes = Number(metadata.size);
  const generation = String(metadata.generation ?? "");
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !generation) {
    throw new Error("project_purge_asset_storage_migration_invalid");
  }
  return {
    sizeBytes,
    contentType:
      typeof metadata.contentType === "string" && metadata.contentType
        ? metadata.contentType
        : "application/octet-stream",
    generation,
    checksum: String(metadata.md5Hash ?? metadata.crc32c ?? metadata.etag ?? ""),
  };
}

function sameLegacyProviderSnapshot(
  left: LegacyProviderObjectSnapshot,
  right: LegacyProviderObjectSnapshot,
): boolean {
  return (
    left.sizeBytes === right.sizeBytes &&
    left.generation === right.generation &&
    left.checksum === right.checksum
  );
}

async function digestReadable(
  body: Readable,
  signal?: AbortSignal,
): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of body) {
    signal?.throwIfAborted();
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    sizeBytes += bytes.length;
    if (!Number.isSafeInteger(sizeBytes)) {
      throw new Error("project_purge_asset_storage_migration_invalid");
    }
    hash.update(bytes);
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

async function copyLegacyProviderObjectToR2(
  plan: LegacyMigrationPlan,
  signal?: AbortSignal,
): Promise<{ sha256: string; sizeBytes: number; sourceGeneration: string }> {
  signal?.throwIfAborted();
  const storage = new ObjectStorageService();
  const file = await withLegacyProviderDeadline(
    () => storage.getObjectEntityFile(plan.sourceKey),
    signal,
  );
  const before = await readLegacyProviderSnapshot(file, signal);
  const sourceHash = createHash("sha256");
  let sourceSize = 0;
  async function* measuredSource() {
    for await (const chunk of file.createReadStream()) {
      signal?.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      sourceSize += bytes.length;
      if (!Number.isSafeInteger(sourceSize) || sourceSize > before.sizeBytes) {
        throw new Error("project_purge_asset_storage_migration_invalid");
      }
      sourceHash.update(bytes);
      yield bytes;
    }
  }
  await putAssetStream({
    key: plan.targetKey,
    body: Readable.from(measuredSource()),
    contentLength: before.sizeBytes,
    contentType: before.contentType || plan.mimeType,
    abortSignal: signal,
  });
  if (sourceSize !== before.sizeBytes) {
    throw new Error("project_purge_asset_storage_migration_invalid");
  }
  const sourceSha256 = sourceHash.digest("hex");
  if (
    plan.expectedSha256 &&
    /^[a-f0-9]{64}$/iu.test(plan.expectedSha256) &&
    plan.expectedSha256.toLowerCase() !== sourceSha256
  ) {
    throw new Error("project_purge_asset_storage_migration_hash_mismatch");
  }
  const head = await headAssetObject(plan.targetKey, signal);
  const opened = await openAsset(plan.targetKey, signal);
  if (
    !head ||
    !opened ||
    head.sizeBytes !== before.sizeBytes ||
    opened.sizeBytes !== before.sizeBytes
  ) {
    throw new Error("project_purge_asset_storage_migration_unverified");
  }
  const copied = await digestReadable(opened.body, signal);
  if (copied.sizeBytes !== before.sizeBytes || copied.sha256 !== sourceSha256) {
    throw new Error("project_purge_asset_storage_migration_hash_mismatch");
  }
  const after = await readLegacyProviderSnapshot(file, signal);
  if (!sameLegacyProviderSnapshot(before, after)) {
    throw new Error("project_purge_asset_storage_migration_source_changed");
  }
  return { ...copied, sourceGeneration: before.generation };
}

async function lockLegacyMigrationKeys(client: PoolClient, keys: readonly string[]): Promise<void> {
  const ordered = await client.query<{ storage_key: string }>(
    `SELECT storage_key FROM (
       SELECT DISTINCT key_row.storage_key COLLATE "C" AS storage_key
         FROM unnest($1::text[]) AS key_row(storage_key)
     ) ordered_keys ORDER BY storage_key COLLATE "C"`,
    [[...new Set(keys)]],
  );
  for (const row of ordered.rows) {
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('nabuflow:durable-object:' || $1, 0)
       )`,
      [row.storage_key],
    );
  }
}

async function assertLegacyMigrationReferenceOwnership(
  client: PoolClient,
  plan: Pick<LegacyMigrationPlan, "projectId" | "assetId" | "ownerUserId" | "sourceKey">,
): Promise<void> {
  const result = await client.query<{ ambiguous: boolean }>(
    `SELECT (
       EXISTS (
         SELECT 1
           FROM project_uploads upload_row
           JOIN projects project_row ON project_row.id=upload_row.project_id
          WHERE upload_row.object_path=$2
            AND upload_row.project_id IS DISTINCT FROM $1
            AND project_row.owner_id IS DISTINCT FROM $3
            AND NOT EXISTS (
              SELECT 1 FROM asset_usage grant_row
               WHERE grant_row.asset_id=$4
                 AND grant_row.project_id=upload_row.project_id
                 AND grant_row.consumer='explicit-project-use:v1'
                 AND grant_row.artifact_id IS NULL
                 AND grant_row.version_id IS NULL
                 AND grant_row.file_path IS NULL
            )
       )
       OR EXISTS (
         SELECT 1
           FROM generated_images image_row
           LEFT JOIN projects project_row ON project_row.id=image_row.project_id
          WHERE image_row.storage_key=$2
            AND image_row.deleted_at IS NULL
            AND image_row.project_id IS DISTINCT FROM $1
            AND (
              image_row.product_scope IS DISTINCT FROM 'nabuflow'
              OR (image_row.project_id IS NULL AND image_row.user_id IS DISTINCT FROM $3)
              OR (
                image_row.project_id IS NOT NULL
                AND project_row.owner_id IS DISTINCT FROM $3
                AND NOT EXISTS (
                  SELECT 1 FROM asset_usage grant_row
                   WHERE grant_row.asset_id=$4
                     AND grant_row.project_id=image_row.project_id
                     AND grant_row.consumer='explicit-project-use:v1'
                     AND grant_row.artifact_id IS NULL
                     AND grant_row.version_id IS NULL
                     AND grant_row.file_path IS NULL
                )
              )
            )
       )
       OR EXISTS (
         SELECT 1
           FROM asset_usage usage_row
           JOIN projects project_row ON project_row.id=usage_row.project_id
          WHERE usage_row.asset_id=$4
            AND usage_row.project_id IS DISTINCT FROM $1
            AND project_row.owner_id IS DISTINCT FROM $3
            AND NOT EXISTS (
              SELECT 1 FROM asset_usage grant_row
               WHERE grant_row.asset_id=$4
                 AND grant_row.project_id=usage_row.project_id
                 AND grant_row.consumer='explicit-project-use:v1'
                 AND grant_row.artifact_id IS NULL
                 AND grant_row.version_id IS NULL
                 AND grant_row.file_path IS NULL
            )
       )
     ) AS ambiguous`,
    [plan.projectId, plan.sourceKey, plan.ownerUserId, plan.assetId],
  );
  if (result.rows[0]?.ambiguous !== false) {
    throw new Error("project_purge_asset_storage_migration_ambiguous");
  }
}

async function reserveLegacyMigration(
  inventory: ProjectPurgeResourceInventory,
  target: ProjectAssetStorageTarget,
): Promise<LegacyMigrationPlan | null> {
  const referenced =
    (await hasSurvivingAssetReference(inventory.projectId, target.assetId)) ||
    (await hasSurvivingObjectReference(inventory.projectId, target.storageKey));
  if (!referenced) return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const asset = await client.query<{
      id: number;
      owner_user_id: string;
      project_id: number | null;
      product_scope: string | null;
      state: string;
      source: string;
      filename: string;
      mime_type: string;
      sha256: string | null;
      storage_backend: string;
      storage_key: string;
    }>(
      `SELECT id, owner_user_id, project_id, product_scope, state, source,
              filename, mime_type, sha256, storage_backend, storage_key
         FROM assets WHERE id=$2 AND project_id=$1 FOR UPDATE`,
      [inventory.projectId, target.assetId],
    );
    const row = asset.rows[0];
    if (
      asset.rowCount !== 1 ||
      !row ||
      row.owner_user_id !== inventory.ownerId ||
      row.product_scope !== "nabuflow" ||
      row.state !== "ready" ||
      row.source !== "legacy-project-upload" ||
      row.storage_backend !== "legacy-object" ||
      row.storage_key !== target.storageKey
    ) {
      throw new Error("project_purge_asset_storage_migration_invalid");
    }
    const targetKey = projectPurgeLegacyMigrationTargetKey({
      assetId: row.id,
      ownerUserId: row.owner_user_id,
      sourceKey: row.storage_key,
      filename: row.filename,
    });
    const objects = await client.query<{
      id: number;
      storage_backend: string;
      storage_key: string;
      role: string;
      state: string;
    }>(
      `SELECT id, storage_backend, storage_key, role, state
         FROM asset_storage_objects
        WHERE asset_id=$1
        ORDER BY storage_key COLLATE "C", id
        FOR UPDATE`,
      [row.id],
    );
    const source = objects.rows.find(
      (object) =>
        object.role === "primary" &&
        object.storage_backend === "legacy-object" &&
        object.storage_key === row.storage_key &&
        object.state !== "deleted",
    );
    const existingTarget = objects.rows.find((object) =>
      object.role.startsWith(LEGACY_MIGRATION_TARGET_ROLE_PREFIX),
    );
    const unexpected = objects.rows.filter(
      (object) =>
        object.state !== "deleted" && object.id !== source?.id && object.id !== existingTarget?.id,
    );
    if (!source || unexpected.length > 0) {
      throw new Error("project_purge_asset_storage_migration_invalid");
    }
    const targetRole = LEGACY_MIGRATION_TARGET_ROLE_PREFIX + inventory.digestSha256;
    if (
      existingTarget &&
      (existingTarget.role !== targetRole ||
        existingTarget.storage_backend !== "r2" ||
        existingTarget.storage_key !== targetKey ||
        existingTarget.state === "deleted")
    ) {
      throw new Error("project_purge_asset_storage_migration_invalid");
    }
    await lockLegacyMigrationKeys(client, [
      row.storage_key,
      targetKey,
      ...objects.rows
        .filter((object) => object.state !== "deleted")
        .map((object) => object.storage_key),
    ]);
    await client.query(
      `SELECT id FROM generated_images
        WHERE asset_id=$1 OR storage_key=$2 ORDER BY id FOR UPDATE`,
      [row.id, row.storage_key],
    );
    await client.query(
      `SELECT id FROM project_uploads
        WHERE object_path=$1 ORDER BY id FOR UPDATE`,
      [row.storage_key],
    );
    await assertLegacyMigrationReferenceOwnership(client, {
      projectId: inventory.projectId,
      assetId: row.id,
      ownerUserId: row.owner_user_id,
      sourceKey: row.storage_key,
    });
    const queryReference: ProjectPurgeBooleanQuery = (statement, values) =>
      client.query<{ shared: boolean }>(statement, values);
    const stillReferenced =
      (await hasSurvivingAssetReference(inventory.projectId, row.id, queryReference)) ||
      (await hasSurvivingObjectReference(inventory.projectId, row.storage_key, queryReference));
    if (!stillReferenced && !existingTarget) {
      await client.query("COMMIT");
      return null;
    }
    let targetObjectId = existingTarget?.id;
    if (!targetObjectId) {
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO asset_storage_objects (
           asset_id, storage_backend, storage_key, role, size_bytes,
           size_measured_at, state
         ) VALUES ($1, 'r2', $2, $3, $4, NULL, 'uploading')
         RETURNING id`,
        [row.id, targetKey, targetRole, target.sizeBytes],
      );
      targetObjectId = inserted.rows[0]?.id;
    }
    if (!Number.isSafeInteger(targetObjectId)) {
      throw new Error("project_purge_asset_storage_migration_invalid");
    }
    await client.query("COMMIT");
    return {
      projectId: inventory.projectId,
      assetId: row.id,
      ownerUserId: row.owner_user_id,
      originDigest: inventory.digestSha256,
      sourceGeneration: null,
      sourceObjectId: source.id,
      sourceKey: row.storage_key,
      targetObjectId: targetObjectId!,
      targetKey,
      filename: row.filename,
      mimeType: row.mime_type,
      expectedSha256: row.sha256,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function removeMigratedLegacySource(
  plan: LegacyMigrationPlan,
  signal?: AbortSignal,
): Promise<void> {
  if (!plan.sourceGeneration) {
    throw new Error("project_purge_asset_storage_migration_invalid");
  }
  await deleteLegacyObjectAndProveAbsent(plan.sourceKey, signal, plan.sourceGeneration);
  const sourceRole = legacyMigrationSourceRole(plan.originDigest, plan.sourceGeneration);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const asset = await client.query<{
      storage_backend: string;
      storage_key: string;
      state: string;
    }>(
      `SELECT storage_backend, storage_key, state
         FROM assets WHERE id=$1 AND project_id=$2 FOR UPDATE`,
      [plan.assetId, plan.projectId],
    );
    if (
      asset.rows[0]?.storage_backend !== "r2" ||
      asset.rows[0]?.storage_key !== plan.targetKey ||
      asset.rows[0]?.state !== "ready"
    ) {
      throw new Error("project_purge_asset_storage_migration_invalid");
    }
    await lockLegacyMigrationKeys(client, [plan.sourceKey, plan.targetKey]);
    const changed = await client.query(
      `UPDATE asset_storage_objects
          SET state='deleted', deleted_at=NOW()
        WHERE id=$1 AND asset_id=$2 AND storage_backend='legacy-object'
          AND storage_key=$3 AND role=$4 AND state='deleting'`,
      [plan.sourceObjectId, plan.assetId, plan.sourceKey, sourceRole],
    );
    if (changed.rowCount !== 1) {
      const existing = await client.query<{ state: string }>(
        "SELECT state FROM asset_storage_objects WHERE id=$1 AND asset_id=$2 AND role=$3",
        [plan.sourceObjectId, plan.assetId, sourceRole],
      );
      if (existing.rows[0]?.state !== "deleted") {
        throw new Error("project_purge_asset_storage_migration_invalid");
      }
    }
    await client.query(
      `DELETE FROM durable_asset_deletion_claims
        WHERE storage_key=$1 AND claim_kind='project-purge-migration'
          AND retired_project_id=$2 AND retired_asset_id=$3`,
      [plan.sourceKey, plan.projectId, plan.assetId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function completeLegacyMigration(
  plan: LegacyMigrationPlan,
  signal?: AbortSignal,
): Promise<void> {
  const copied = await copyLegacyProviderObjectToR2(plan, signal);
  const targetRole = LEGACY_MIGRATION_TARGET_ROLE_PREFIX + plan.originDigest;
  const sourceRole = legacyMigrationSourceRole(plan.originDigest, copied.sourceGeneration);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const asset = await client.query<{
      owner_user_id: string;
      project_id: number | null;
      product_scope: string | null;
      state: string;
      source: string;
      sha256: string | null;
      storage_backend: string;
      storage_key: string;
    }>(
      `SELECT owner_user_id, project_id, product_scope, state, source, sha256,
              storage_backend, storage_key
         FROM assets WHERE id=$1 AND project_id=$2 FOR UPDATE`,
      [plan.assetId, plan.projectId],
    );
    const row = asset.rows[0];
    if (
      asset.rowCount !== 1 ||
      !row ||
      row.owner_user_id !== plan.ownerUserId ||
      row.product_scope !== "nabuflow" ||
      row.state !== "ready" ||
      row.source !== "legacy-project-upload" ||
      row.storage_backend !== "legacy-object" ||
      row.storage_key !== plan.sourceKey ||
      (row.sha256 &&
        /^[a-f0-9]{64}$/iu.test(row.sha256) &&
        row.sha256.toLowerCase() !== copied.sha256)
    ) {
      throw new Error("project_purge_asset_storage_migration_invalid");
    }
    const objects = await client.query<{
      id: number;
      storage_backend: string;
      storage_key: string;
      role: string;
      state: string;
    }>(
      `SELECT id, storage_backend, storage_key, role, state
         FROM asset_storage_objects WHERE asset_id=$1
         ORDER BY storage_key COLLATE "C", id FOR UPDATE`,
      [plan.assetId],
    );
    const source = objects.rows.find((object) => object.id === plan.sourceObjectId);
    const target = objects.rows.find((object) => object.id === plan.targetObjectId);
    if (
      source?.role !== "primary" ||
      source.storage_backend !== "legacy-object" ||
      source.storage_key !== plan.sourceKey ||
      source.state === "deleted" ||
      target?.role !== targetRole ||
      target.storage_backend !== "r2" ||
      target.storage_key !== plan.targetKey ||
      target.state === "deleted"
    ) {
      throw new Error("project_purge_asset_storage_migration_invalid");
    }
    await lockLegacyMigrationKeys(client, [plan.sourceKey, plan.targetKey]);
    await client.query(
      `SELECT id FROM generated_images
        WHERE asset_id=$1 OR storage_key=$2 ORDER BY id FOR UPDATE`,
      [plan.assetId, plan.sourceKey],
    );
    await client.query(
      `SELECT id FROM project_uploads
        WHERE object_path=$1 ORDER BY id FOR UPDATE`,
      [plan.sourceKey],
    );
    await assertLegacyMigrationReferenceOwnership(client, plan);
    const aliases = await client.query<{ alias: string }>(
      `SELECT '/api/images/' || image.id::text || '/file' AS alias
       FROM generated_images image
          WHERE image.deleted_at IS NULL
            AND (image.asset_id=$1 OR image.storage_key=$2)
         UNION
         SELECT '/api/projects/' || upload.project_id::text || '/uploads/' ||
                upload.id::text || '/content'
           FROM project_uploads upload WHERE upload.object_path=$2`,
      [plan.assetId, plan.sourceKey],
    );
    await canonicalizeLockedAssetAliases(client, plan.projectId, plan.assetId, "nabuflow", "r2", [
      ...aliases.rows,
      { alias: plan.sourceKey },
    ]);
    const claim = await client.query(
      `INSERT INTO durable_asset_deletion_claims (
         storage_key, claim_kind, retired_project_id, retired_asset_id
       ) VALUES ($1, 'project-purge-migration', $2, $3)
       ON CONFLICT (storage_key) DO NOTHING`,
      [plan.sourceKey, plan.projectId, plan.assetId],
    );
    if (claim.rowCount !== 1) {
      const existing = await client.query<{
        claim_kind: string;
        retired_project_id: number | null;
        retired_asset_id: number | null;
      }>(
        `SELECT claim_kind, retired_project_id, retired_asset_id
           FROM durable_asset_deletion_claims WHERE storage_key=$1`,
        [plan.sourceKey],
      );
      if (
        existing.rows[0]?.claim_kind !== "project-purge-migration" ||
        existing.rows[0]?.retired_project_id !== plan.projectId ||
        existing.rows[0]?.retired_asset_id !== plan.assetId
      ) {
        throw new Error("project_purge_asset_storage_migration_invalid");
      }
    }
    const sourceChanged = await client.query(
      `UPDATE asset_storage_objects
          SET role=$2, state='deleting'
        WHERE id=$1 AND asset_id=$3 AND role='primary'
          AND storage_backend='legacy-object' AND storage_key=$4
          AND state <> 'deleted'`,
      [plan.sourceObjectId, sourceRole, plan.assetId, plan.sourceKey],
    );
    const targetChanged = await client.query(
      `UPDATE asset_storage_objects
          SET role='primary', state='ready', size_bytes=$2,
              size_measured_at=NOW(), ready_at=COALESCE(ready_at, NOW())
        WHERE id=$1 AND asset_id=$3 AND role=$4
          AND storage_backend='r2' AND storage_key=$5
          AND state <> 'deleted'`,
      [plan.targetObjectId, copied.sizeBytes, plan.assetId, targetRole, plan.targetKey],
    );
    const assetChanged = await client.query(
      `UPDATE assets
          SET storage_backend='r2', storage_key=$3, sha256=COALESCE(sha256, $4)
        WHERE id=$1 AND project_id=$2 AND product_scope='nabuflow'
          AND state='ready' AND source='legacy-project-upload'
          AND storage_backend='legacy-object' AND storage_key=$5`,
      [plan.assetId, plan.projectId, plan.targetKey, copied.sha256, plan.sourceKey],
    );
    if (
      sourceChanged.rowCount !== 1 ||
      targetChanged.rowCount !== 1 ||
      assetChanged.rowCount !== 1
    ) {
      throw new Error("project_purge_asset_storage_migration_invalid");
    }
    await client.query(
      `UPDATE project_uploads upload_row
          SET object_path=$3
         FROM projects project_row
        WHERE upload_row.project_id=project_row.id
          AND upload_row.project_id IS DISTINCT FROM $1
          AND upload_row.object_path=$2
          AND project_row.owner_id=$4`,
      [plan.projectId, plan.sourceKey, plan.targetKey, plan.ownerUserId],
    );
    await client.query(
      `UPDATE generated_images
          SET storage_key=$3
        WHERE project_id IS DISTINCT FROM $1
          AND storage_key=$2
          AND deleted_at IS NULL
          AND product_scope='nabuflow'
          AND user_id=$4`,
      [plan.projectId, plan.sourceKey, plan.targetKey, plan.ownerUserId],
    );
    const queryReference: ProjectPurgeBooleanQuery = (statement, values) =>
      client.query<{ shared: boolean }>(statement, values);
    if (
      await hasSurvivingObjectReference(
        plan.projectId,
        plan.sourceKey,
        queryReference,
        plan.sourceObjectId,
      )
    ) {
      throw new Error("project_purge_asset_storage_migration_unresolved_reference");
    }
    if (await hasSurvivingAssetReference(plan.projectId, plan.assetId, queryReference)) {
      await client.query(
        `INSERT INTO asset_usage (asset_id, project_id, consumer)
         SELECT $1, NULL, 'project-purge-preserved-direct:' || $2::text
          WHERE NOT EXISTS (
            SELECT 1 FROM asset_usage
             WHERE asset_id=$1 AND project_id IS NULL
               AND consumer='project-purge-preserved-direct:' || $2::text
          )`,
        [plan.assetId, plan.projectId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  await removeMigratedLegacySource({ ...plan, sourceGeneration: copied.sourceGeneration }, signal);
}

function planFromPendingTarget(
  inventory: ProjectPurgeResourceInventory,
  target: ProjectAssetStorageTarget,
): LegacyMigrationPlan {
  if (
    !target.migrationTargetObjectId ||
    !target.migrationTargetKey ||
    !target.migrationTargetRole
  ) {
    throw new Error("project_purge_asset_storage_migration_invalid");
  }
  return {
    projectId: inventory.projectId,
    assetId: target.assetId,
    ownerUserId: target.ownerUserId,
    originDigest: migrationRoleDigest(
      target.migrationTargetRole,
      LEGACY_MIGRATION_TARGET_ROLE_PREFIX,
    ),
    sourceGeneration: null,
    sourceObjectId: target.storageObjectId!,
    sourceKey: target.storageKey,
    targetObjectId: target.migrationTargetObjectId,
    targetKey: target.migrationTargetKey,
    filename: target.filename ?? "legacy-upload",
    mimeType: target.mimeType ?? "application/octet-stream",
    expectedSha256: target.sha256 ?? null,
  };
}

function planFromMigratedSource(
  inventory: ProjectPurgeResourceInventory,
  target: ProjectAssetStorageTarget,
): LegacyMigrationPlan {
  if (
    !target.migrationSourceObjectId ||
    !target.migrationSourceKey ||
    !target.migrationSourceRole ||
    !target.storageObjectId
  ) {
    throw new Error("project_purge_asset_storage_migration_invalid");
  }
  const { originDigest, sourceGeneration } = parseLegacyMigrationSourceRole(
    target.migrationSourceRole,
  );
  return {
    projectId: inventory.projectId,
    assetId: target.assetId,
    ownerUserId: target.ownerUserId,
    originDigest,
    sourceGeneration,
    sourceObjectId: target.migrationSourceObjectId,
    sourceKey: target.migrationSourceKey,
    targetObjectId: target.storageObjectId,
    targetKey: target.storageKey,
    filename: target.filename ?? "legacy-upload",
    mimeType: target.mimeType ?? "application/octet-stream",
    expectedSha256: target.sha256 ?? null,
  };
}

export async function migrateRetainedLegacyAssetsForPurge(
  inventory: ProjectPurgeResourceInventory,
  signal?: AbortSignal,
): Promise<boolean> {
  let changed = false;
  const targets = new Map<number, ProjectAssetStorageTarget>();
  for (const target of inventory.assetTargets) {
    if (!targets.has(target.assetId)) targets.set(target.assetId, target);
  }
  for (const target of targets.values()) {
    signal?.throwIfAborted();
    if (target.migrationSourceState === "deleting" && target.storageBackend === "r2") {
      await removeMigratedLegacySource(planFromMigratedSource(inventory, target), signal);
      changed = true;
      continue;
    }
    if (target.storageBackend !== "legacy-object") continue;
    const plan = target.migrationTargetObjectId
      ? planFromPendingTarget(inventory, target)
      : await reserveLegacyMigration(inventory, target);
    if (!plan) continue;
    await completeLegacyMigration(plan, signal);
    changed = true;
  }
  return changed;
}

/**
 * Legacy image/upload routes name metadata that is intentionally destroyed with
 * its source project. Before that metadata disappears, rewrite every surviving
 * durable reference to the stable asset route while the asset row is locked.
 * The write guards then serialize a concurrent legacy-alias writer behind this
 * transaction; after commit that writer cannot resolve the removed alias.
 */
export async function canonicalizeSurvivingAssetAliases(
  client: PoolClient,
  excludedProjectId: number | null,
  assetId: number,
): Promise<void> {
  const aliases = await client.query<{ alias: string }>(
    `SELECT '/api/images/' || image.id::text || '/file' AS alias
       FROM generated_images image
      WHERE image.asset_id=$1 AND image.deleted_at IS NULL
     UNION
     SELECT '/api/projects/' || upload.project_id::text || '/uploads/' || upload.id::text || '/content'
       FROM project_uploads upload
       JOIN assets asset
         ON asset.id=$1
        AND asset.storage_key=upload.object_path`,
    [assetId],
  );
  const asset = await client.query<{ product_scope: string | null; storage_backend: string }>(
    "SELECT product_scope, storage_backend FROM assets WHERE id=$1",
    [assetId],
  );
  if (asset.rows.length !== 1) throw new Error("project_purge_asset_release_failed");
  await canonicalizeLockedAssetAliases(
    client,
    excludedProjectId,
    assetId,
    asset.rows[0]!.product_scope,
    asset.rows[0]!.storage_backend,
    aliases.rows,
  );
}

async function assertCanonicalizationReferenceAuthority(
  client: PoolClient,
  excludedProjectId: number | null,
  assetId: number,
  aliases: readonly { alias: string }[],
  aliasesToRewrite: readonly string[] = [],
): Promise<void> {
  const tokens = [...new Set(aliases.map((row) => row.alias).filter(Boolean))];
  if (tokens.length === 0) return;
  // NULL excludes no project. The precheck must cover every rewrite candidate,
  // including detached library/template rows with no provable owner authority.
  const result = await client.query<{ allowed: boolean }>(
    `WITH durable_reference_rows (
       project_id, reference_user_id, reference_product_scope, payload
     ) AS (
       SELECT message_row.project_id, NULL::text, NULL::text, to_jsonb(message_row)::text
         FROM chat_messages message_row
        WHERE ($1::integer IS NULL OR message_row.project_id IS DISTINCT FROM $1)
       UNION ALL
       SELECT task_row.project_id, NULL::text, NULL::text, to_jsonb(task_row)::text
         FROM agent_tasks task_row
        WHERE ($1::integer IS NULL OR task_row.project_id IS DISTINCT FROM $1)
       UNION ALL
       SELECT call_row.project_id, NULL::text, NULL::text, to_jsonb(call_row)::text
         FROM agent_tool_calls call_row
        WHERE ($1::integer IS NULL OR call_row.project_id IS DISTINCT FROM $1)
       UNION ALL
       SELECT queue_row.project_id, NULL::text, NULL::text, to_jsonb(queue_row)::text
         FROM zero_prompt_queue_items queue_row
        WHERE ($1::integer IS NULL OR queue_row.project_id IS DISTINCT FROM $1)
       UNION ALL
       SELECT knowledge_row.project_id, NULL::text, NULL::text, to_jsonb(knowledge_row)::text
         FROM knowledge_entries knowledge_row
        WHERE ($1::integer IS NULL OR knowledge_row.project_id IS DISTINCT FROM $1)
       UNION ALL
       SELECT file_row.project_id, NULL::text, NULL::text, to_jsonb(file_row)::text
         FROM project_files file_row
        WHERE ($1::integer IS NULL OR file_row.project_id IS DISTINCT FROM $1)
       UNION ALL
       SELECT version_row.project_id, NULL::text, NULL::text, to_jsonb(version_row)::text
         FROM project_versions version_row
        WHERE ($1::integer IS NULL OR version_row.project_id IS DISTINCT FROM $1)
       UNION ALL
       SELECT variant_row.project_id, NULL::text, NULL::text, to_jsonb(variant_row)::text
         FROM canvas_variants variant_row
        WHERE ($1::integer IS NULL OR variant_row.project_id IS DISTINCT FROM $1)
       UNION ALL
       SELECT library_row.source_project_id, NULL::text, NULL::text, to_jsonb(library_row)::text
         FROM canvas_variant_library library_row
       UNION ALL
       SELECT template_row.source_project_id, NULL::text, NULL::text, to_jsonb(template_row)::text
         FROM gallery_templates template_row
       UNION ALL
       SELECT inbox_row.project_id, NULL::text, NULL::text, to_jsonb(inbox_row)::text
         FROM agent_inbox inbox_row
        WHERE ($1::integer IS NULL OR inbox_row.project_id IS DISTINCT FROM $1)
       UNION ALL
       SELECT task_row.project_id, NULL::text, NULL::text, to_jsonb(event_row)::text
         FROM task_events event_row
         JOIN agent_tasks task_row ON task_row.id=event_row.task_id
        WHERE ($1::integer IS NULL OR task_row.project_id IS DISTINCT FROM $1)
       UNION ALL
       SELECT activity_row.project_id, NULL::text, NULL::text, to_jsonb(activity_row)::text
         FROM project_activity activity_row
        WHERE ($1::integer IS NULL OR activity_row.project_id IS DISTINCT FROM $1)
       UNION ALL
       SELECT edit_row.project_id, NULL::text, NULL::text, to_jsonb(edit_row)::text
         FROM visual_edit_changes edit_row
        WHERE ($1::integer IS NULL OR edit_row.project_id IS DISTINCT FROM $1)
       UNION ALL
       SELECT image_row.project_id, image_row.user_id, image_row.product_scope,
              to_jsonb(image_row)::text
         FROM generated_images image_row
        WHERE image_row.deleted_at IS NULL
          AND ($1::integer IS NULL OR image_row.project_id IS DISTINCT FROM $1)
       UNION ALL
       -- The ticket's project is exclusion metadata, not asset authority.
       -- The durable attachability trigger treats tickets as Ora account data.
       SELECT NULL::integer, ticket_row.user_id, 'ora'::text, to_jsonb(ticket_row)::text
         FROM support_tickets ticket_row
        WHERE ($1::integer IS NULL OR ticket_row.project_id IS DISTINCT FROM $1)
     ), matched_references AS (
       SELECT reference_row.*
         FROM durable_reference_rows reference_row
        WHERE EXISTS (
          SELECT 1 FROM unnest($3::text[]) alias_row(alias)
           WHERE position(alias_row.alias in reference_row.payload) > 0
        )
     ), asset_authority AS (
       SELECT owner_user_id, product_scope FROM assets WHERE id=$2
     )
     SELECT NOT EXISTS (
       SELECT 1
         FROM matched_references reference_row
         CROSS JOIN asset_authority authority
         LEFT JOIN projects project_row ON project_row.id=reference_row.project_id
        WHERE reference_row.reference_product_scope IS DISTINCT FROM NULL
              AND reference_row.reference_product_scope IS DISTINCT FROM authority.product_scope
           OR reference_row.project_id IS NULL
              AND (
                reference_row.reference_user_id IS DISTINCT FROM authority.owner_user_id
                OR reference_row.reference_product_scope IS DISTINCT FROM authority.product_scope
              )
           OR reference_row.project_id IS NOT NULL
              AND (
                project_row.id IS NULL
                OR (
                  project_row.owner_id IS DISTINCT FROM authority.owner_user_id
                  AND NOT EXISTS (
                    SELECT 1 FROM asset_usage grant_row
                     WHERE grant_row.asset_id=$2
                       AND grant_row.project_id=reference_row.project_id
                       AND grant_row.consumer='explicit-project-use:v1'
                       AND grant_row.artifact_id IS NULL
                       AND grant_row.version_id IS NULL
                       AND grant_row.file_path IS NULL
                  )
                )
              )
     ) AND NOT EXISTS (
       SELECT 1 FROM support_tickets ticket_row
        WHERE ($1::integer IS NULL OR ticket_row.project_id IS DISTINCT FROM $1)
          AND EXISTS (
            SELECT 1 FROM unnest($4::text[]) alias_row(alias)
             WHERE position(
               alias_row.alias in (to_jsonb(ticket_row) - 'transcript' - 'attachments')::text
             ) > 0
          )
     ) AS allowed
       FROM asset_authority`,
    [excludedProjectId, assetId, tokens, aliasesToRewrite],
  );
  if (result.rows[0]?.allowed !== true) {
    throw new Error("project_purge_asset_reference_forbidden");
  }
}

async function canonicalizeLockedAssetAliases(
  client: PoolClient,
  excludedProjectId: number | null,
  assetId: number,
  productScope: string | null,
  storageBackend: string,
  aliases: readonly { alias: string }[],
): Promise<void> {
  if (!isProductScope(productScope) || storageBackend !== "r2") {
    // A canonical route needs both proven product authority and a deliverable
    // backend. Rollback preserves the working legacy alias and its provider bytes.
    for (const { alias } of aliases) {
      if (
        excludedProjectId === null ||
        (await hasSurvivingObjectReference(excludedProjectId, alias, (statement, values) =>
          client.query<{ shared: boolean }>(statement, values),
        ))
      ) {
        throw new Error(
          !isProductScope(productScope)
            ? "project_purge_asset_origin_unresolved"
            : "project_purge_asset_storage_migration_required",
        );
      }
    }
    return;
  }
  const canonical = canonicalAssetContentUrl(assetId, productScope);
  await assertCanonicalizationReferenceAuthority(
    client,
    excludedProjectId,
    assetId,
    aliases,
    aliases.filter(({ alias }) => alias !== canonical).map(({ alias }) => alias),
  );
  for (const row of aliases) {
    if (row.alias === canonical) continue;
    const values = [excludedProjectId, row.alias, canonical];
    await client.query(
      `UPDATE chat_messages
          SET attachments=replace(attachments::text, $2, $3)::jsonb
        WHERE ($1::integer IS NULL OR project_id IS DISTINCT FROM $1)
          AND position($2 in coalesce(attachments::text, '')) > 0`,
      values,
    );
    await client.query(
      `UPDATE agent_tasks
          SET attachments=CASE WHEN position($2 in coalesce(attachments::text, '')) > 0
                               THEN replace(attachments::text, $2, $3)::jsonb ELSE attachments END,
              report=CASE WHEN position($2 in coalesce(report::text, '')) > 0
                          THEN replace(report::text, $2, $3)::jsonb ELSE report END,
              staging_snapshot=CASE WHEN position($2 in coalesce(staging_snapshot::text, '')) > 0
                                    THEN replace(staging_snapshot::text, $2, $3)::jsonb ELSE staging_snapshot END
        WHERE ($1::integer IS NULL OR project_id IS DISTINCT FROM $1)
          AND (position($2 in coalesce(attachments::text, '')) > 0
            OR position($2 in coalesce(report::text, '')) > 0
            OR position($2 in coalesce(staging_snapshot::text, '')) > 0)`,
      values,
    );
    await client.query(
      `UPDATE agent_tool_calls call_row
          SET stdout_preview=replace(call_row.stdout_preview, $2, $3),
              args_summary=replace(call_row.args_summary, $2, $3)
        WHERE ($1::integer IS NULL OR call_row.project_id IS DISTINCT FROM $1)
          AND (position($2 in coalesce(call_row.stdout_preview, '')) > 0
            OR position($2 in coalesce(call_row.args_summary, '')) > 0)`,
      values,
    );
    await client.query(
      `UPDATE zero_prompt_queue_items
          SET current_text=replace(current_text, $2, $3)
        WHERE ($1::integer IS NULL OR project_id IS DISTINCT FROM $1)
          AND position($2 in current_text) > 0`,
      values,
    );
    await client.query(
      `UPDATE knowledge_entries
          SET annotation=replace(annotation, $2, $3)
        WHERE ($1::integer IS NULL OR project_id IS DISTINCT FROM $1)
          AND position($2 in coalesce(annotation, '')) > 0`,
      values,
    );
    await client.query(
      `UPDATE project_files SET content=replace(content, $2, $3)
        WHERE ($1::integer IS NULL OR project_id IS DISTINCT FROM $1)
          AND position($2 in content) > 0`,
      values,
    );
    await client.query(
      `UPDATE project_versions
          SET files_snapshot=replace(files_snapshot::text, $2, $3)::jsonb
        WHERE ($1::integer IS NULL OR project_id IS DISTINCT FROM $1)
          AND position($2 in coalesce(files_snapshot::text, '')) > 0`,
      values,
    );
    await client.query(
      `UPDATE canvas_variants SET files=replace(files::text, $2, $3)::jsonb
        WHERE ($1::integer IS NULL OR project_id IS DISTINCT FROM $1)
          AND position($2 in coalesce(files::text, '')) > 0`,
      values,
    );
    await client.query(
      `UPDATE canvas_variant_library SET files=replace(files::text, $1, $2)::jsonb
        WHERE position($1 in coalesce(files::text, '')) > 0`,
      [row.alias, canonical],
    );
    await client.query(
      `UPDATE gallery_templates
          SET files_snapshot=replace(files_snapshot::text, $1, $2)::jsonb
        WHERE position($1 in coalesce(files_snapshot::text, '')) > 0`,
      [row.alias, canonical],
    );
    await client.query(
      `UPDATE agent_inbox SET screenshot_url=replace(screenshot_url, $2, $3)
        WHERE ($1::integer IS NULL OR project_id IS DISTINCT FROM $1)
          AND position($2 in coalesce(screenshot_url, '')) > 0`,
      values,
    );
    await client.query(
      `UPDATE task_events event_row
          SET message=replace(event_row.message, $2, $3),
              data=CASE WHEN position($2 in coalesce(event_row.data::text, '')) > 0
                        THEN replace(event_row.data::text, $2, $3)::jsonb ELSE event_row.data END
        WHERE EXISTS (
          SELECT 1 FROM agent_tasks task
           WHERE task.id=event_row.task_id
             AND ($1::integer IS NULL OR task.project_id IS DISTINCT FROM $1)
        ) AND (position($2 in coalesce(event_row.message, '')) > 0
            OR position($2 in coalesce(event_row.data::text, '')) > 0)`,
      values,
    );
    await client.query(
      `UPDATE project_activity SET metadata=replace(metadata::text, $2, $3)::jsonb
        WHERE ($1::integer IS NULL OR project_id IS DISTINCT FROM $1)
          AND position($2 in coalesce(metadata::text, '')) > 0`,
      values,
    );
    await client.query(
      `UPDATE visual_edit_changes
          SET before_content=replace(before_content, $2, $3),
              after_content=replace(after_content, $2, $3)
        WHERE ($1::integer IS NULL OR project_id IS DISTINCT FROM $1)
          AND (position($2 in before_content) > 0 OR position($2 in after_content) > 0)`,
      values,
    );
    await client.query(
      `UPDATE generated_images
          SET file_url=replace(file_url, $2, $3),
              thumbnail_url=replace(thumbnail_url, $2, $3),
              updated_at=NOW()
        WHERE ($1::integer IS NULL OR project_id IS DISTINCT FROM $1)
          AND generated_images.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM assets authority
             WHERE authority.id=$4
               AND generated_images.product_scope=authority.product_scope
               AND (generated_images.project_id IS NOT NULL
                 OR generated_images.user_id=authority.owner_user_id)
          )
          AND (position($2 in coalesce(file_url, '')) > 0
            OR position($2 in coalesce(thumbnail_url, '')) > 0)`,
      [...values, assetId],
    );
    // Preserve ticket identity/history; only these guarded payload columns may
    // be canonicalized, and a project association never supplies user authority.
    await client.query(
      `UPDATE support_tickets ticket_row
          SET transcript=replace(ticket_row.transcript::text, $2, $3)::jsonb,
              attachments=replace(ticket_row.attachments::text, $2, $3)::jsonb
        WHERE ($1::integer IS NULL OR ticket_row.project_id IS DISTINCT FROM $1)
          AND EXISTS (
            SELECT 1 FROM assets authority
             WHERE authority.id=$4 AND authority.product_scope='ora'
               AND ticket_row.user_id=authority.owner_user_id
          )
          AND (position($2 in ticket_row.transcript::text) > 0
            OR position($2 in ticket_row.attachments::text) > 0)`,
      [...values, assetId],
    );
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error("project_purge_catalog_invalid");
  return `"${value}"`;
}

export async function readProjectReferenceCatalog(): Promise<ProjectReferenceCatalogRow[]> {
  const result = await pool.query<{
    table_name: string;
    column_name: "project_id" | "source_project_id";
    delete_action: "cascade" | "set_null" | "restrict" | "no_fk";
    foreign_key_count: number;
    referenced_table_schema: string | null;
    referenced_table_name: string | null;
    referenced_column_name: string | null;
  }>(`
    SELECT column_row.table_name,
           column_row.column_name,
           CASE WHEN constraint_row.foreign_key_count <> 1 THEN 'no_fk'
             ELSE CASE constraint_row.confdeltype
             WHEN 'c' THEN 'cascade'
             WHEN 'n' THEN 'set_null'
             WHEN 'r' THEN 'restrict'
             WHEN 'a' THEN 'restrict'
             ELSE 'no_fk'
             END
           END AS delete_action,
           constraint_row.foreign_key_count,
           constraint_row.referenced_table_schema,
           constraint_row.referenced_table_name,
           constraint_row.referenced_column_name
      FROM information_schema.columns column_row
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::integer AS foreign_key_count,
               CASE WHEN COUNT(*) = 1 THEN MIN(constraint_value.confdeltype::text) END
                 AS confdeltype,
               CASE WHEN COUNT(*) = 1 THEN MIN(referenced_namespace.nspname) END
                 AS referenced_table_schema,
               CASE WHEN COUNT(*) = 1 THEN MIN(referenced_relation.relname) END
                 AS referenced_table_name,
               CASE WHEN COUNT(*) = 1 THEN MIN(referenced_attribute.attname) END
                 AS referenced_column_name
          FROM pg_constraint constraint_value
          JOIN pg_class relation ON relation.oid = constraint_value.conrelid
          JOIN pg_namespace namespace_value ON namespace_value.oid = relation.relnamespace
          JOIN pg_attribute source_attribute
            ON source_attribute.attrelid = relation.oid
           AND source_attribute.attname = column_row.column_name
          JOIN pg_class referenced_relation ON referenced_relation.oid = constraint_value.confrelid
          JOIN pg_namespace referenced_namespace
            ON referenced_namespace.oid = referenced_relation.relnamespace
          JOIN pg_attribute referenced_attribute
            ON referenced_attribute.attrelid = referenced_relation.oid
           AND referenced_attribute.attnum = constraint_value.confkey[
             array_position(constraint_value.conkey, source_attribute.attnum)
           ]
         WHERE constraint_value.contype = 'f'
           AND namespace_value.nspname = 'public'
           AND relation.relname = column_row.table_name
           AND constraint_value.conkey @> ARRAY[source_attribute.attnum]::smallint[]
      ) constraint_row ON TRUE
     WHERE column_row.table_schema = 'public'
       AND column_row.column_name IN ('project_id', 'source_project_id')
     ORDER BY column_row.table_name, column_row.column_name
  `);
  return result.rows.map((row) => ({
    tableName: row.table_name,
    columnName: row.column_name,
    deleteAction: row.delete_action,
    foreignKeyCount: Number(row.foreign_key_count),
    referencedTableSchema: row.referenced_table_schema,
    referencedTableName: row.referenced_table_name,
    referencedColumnName: row.referenced_column_name,
  }));
}

async function countProjectReferences(
  projectId: number,
  catalog: readonly ProjectReferenceCatalogRow[],
  runQuery: (
    statement: string,
    values: readonly unknown[],
  ) => Promise<{ rows: Array<{ ordinal: number; row_count: number }> }> = (statement, values) =>
    pool.query(statement, values as unknown[]),
): Promise<Array<{ tableName: string; columnName: string; rowCount: number }>> {
  const relevant = catalog.filter((row) => {
    const policy = PROJECT_REFERENCE_POLICIES[row.tableName]?.[row.columnName];
    return policy !== "other_product" && policy !== "preserve_receipt";
  });
  if (relevant.length === 0) return [];
  const query = relevant
    .map(
      (row, index) =>
        `SELECT ${index}::integer AS ordinal, COUNT(*)::integer AS row_count FROM ${quoteIdentifier(row.tableName)} WHERE ${quoteIdentifier(row.columnName)}=$1`,
    )
    .join(" UNION ALL ");
  const result = await runQuery(query, [projectId]);
  return result.rows.map((entry) => ({
    tableName: relevant[entry.ordinal]!.tableName,
    columnName: relevant[entry.ordinal]!.columnName,
    rowCount: Number(entry.row_count),
  }));
}

export async function inventoryProjectPurgeResources(
  projectId: number,
  signal?: AbortSignal,
): Promise<ProjectPurgeResourceInventory | null> {
  const catalog = await readProjectReferenceCatalog();
  const catalogDecision = validateProjectReferenceCatalog(catalog);
  if (!catalogDecision.ok) throw new Error("project_purge_inventory_unavailable");

  const projectResult = await pool.query<{
    id: number;
    owner_id: string;
    name: string;
    deleted_at: Date | null;
    neon_project_id: string | null;
    db_connection_id: string | null;
    db_provider: string;
    db_status: string;
    preview_db_status: string;
    preview_db_has_url: boolean;
    preview_db_allocation: unknown;
    retirement_operation_id: string | null;
    retirement_state: string | null;
    retirement_completed_at: Date | null;
    retirement_progress: unknown;
  }>(
    `SELECT project_row.id, project_row.owner_id, project_row.name,
            project_row.deleted_at, project_row.neon_project_id,
            project_row.db_connection_id, project_row.db_provider, project_row.db_status,
            project_row.preview_db_status,
            (project_row.preview_db_url IS NOT NULL) AS preview_db_has_url,
            project_row.preview_db_allocation,
            retirement_row.id AS retirement_operation_id,
            retirement_row.state AS retirement_state,
            retirement_row.completed_at AS retirement_completed_at,
            retirement_row.progress AS retirement_progress
       FROM projects project_row
       LEFT JOIN LATERAL (
         SELECT operation.id, operation.state, operation.completed_at, operation.progress
           FROM project_retirement_operations operation
          WHERE operation.project_id=project_row.id
          ORDER BY operation.created_at DESC
          LIMIT 1
       ) retirement_row ON TRUE
      WHERE project_row.id=$1
      LIMIT 1`,
    [projectId],
  );
  const project = projectResult.rows[0];
  if (!project) return null;
  if (
    !project.deleted_at ||
    !project.retirement_operation_id ||
    project.retirement_state !== "completed" ||
    !project.retirement_completed_at ||
    !hasCurrentProjectRetirementCompletionEvidence(project.retirement_progress)
  ) {
    throw new Error("project_purge_retirement_incomplete");
  }

  const allocationState = {
    dbProvider: project.db_provider,
    dbStatus: project.db_status,
    neonProjectId: project.neon_project_id,
    dbConnectionId: project.db_connection_id,
  };
  if (hasUnresolvedNeonAllocationIntent(allocationState)) {
    const recoveredId = await reconcileNeonAllocationIntent({
      projectId,
      state: allocationState,
      recordOwnership: async (id) => {
        // Metadata-only recovery is CAS-fenced to this exact owner, tombstone,
        // and unresolved attempt. A concurrent restore/change wins safely.
        const changed = await pool.query(
          `UPDATE projects SET neon_project_id=$2, db_connection_id=$2
            WHERE id=$1 AND owner_id=$3 AND deleted_at=$4
              AND db_provider=$5 AND db_status=$6
              AND neon_project_id IS NULL AND db_connection_id IS NULL
            RETURNING id`,
          [
            projectId,
            id,
            project.owner_id,
            project.deleted_at,
            project.db_provider,
            project.db_status,
          ],
        );
        return changed.rowCount === 1;
      },
    });
    if (!recoveredId) throw new Error("project_purge_neon_allocation_unresolved");
    project.neon_project_id = recoveredId;
    project.db_connection_id = recoveredId;
  }

  const previewDatabase: PreviewDatabaseState = {
    status: project.preview_db_status,
    hasCredential: project.preview_db_has_url,
    allocation: project.preview_db_allocation,
  };
  if (hasUnresolvedPreviewDatabaseAllocation(projectId, previewDatabase)) {
    const lease = await pool.query<{ id: string; lease_version: number }>(
      "SELECT id, lease_version FROM project_purge_operations " +
        "WHERE project_id=$1 AND state='running' AND lease_expires_at>NOW()",
      [projectId],
    );
    if (lease.rows.length !== 1) throw new Error("project_purge_preview_allocation_unresolved");
    const authority = lease.rows[0]!;
    const recovered = await reconcilePreviewDatabaseAllocation({
      projectId,
      state: previewDatabase,
      recordReceipt: async (expected, next) => {
        // Cleanup-only evidence is CAS-bound to the exact owner, tombstone, and old receipt.
        const changed = await pool.query(
          `UPDATE projects SET preview_db_allocation=$2::jsonb
            WHERE id=$1 AND owner_id=$3 AND deleted_at=$4
              AND preview_db_status=$5 AND (preview_db_url IS NOT NULL)=$6
              AND preview_db_allocation IS NOT DISTINCT FROM $7::jsonb
              AND EXISTS (SELECT 1 FROM project_purge_operations
                WHERE id=$8 AND project_id=$1 AND state='running'
                  AND lease_version=$9 AND lease_expires_at>NOW())
            RETURNING id`,
          [
            projectId,
            JSON.stringify(next),
            project.owner_id,
            project.deleted_at,
            project.preview_db_status,
            project.preview_db_has_url,
            expected === null ? null : JSON.stringify(expected),
            authority.id,
            authority.lease_version,
          ],
        );
        return changed.rowCount === 1;
      },
    });
    previewDatabase.allocation = recovered;
    if (hasUnresolvedPreviewDatabaseAllocation(projectId, previewDatabase)) {
      throw new Error("project_purge_preview_allocation_unresolved");
    }
  }
  const previewAllocation = parsePreviewDatabaseAllocation(projectId, previewDatabase.allocation);

  const assetResult = await pool.query<{
    asset_id: number;
    owner_user_id: string;
    filename: string;
    mime_type: string;
    sha256: string | null;
    storage_object_id: number | null;
    storage_backend: string | null;
    storage_key: string | null;
    size_bytes: string | number | null;
    migration_source_object_id: number | null;
    migration_source_backend: string | null;
    migration_source_key: string | null;
    migration_source_role: string | null;
    migration_source_state: string | null;
    migration_target_object_id: number | null;
    migration_target_key: string | null;
    migration_target_role: string | null;
    migration_target_state: string | null;
    shared: boolean;
  }>(
    `SELECT asset_row.id AS asset_id,
            asset_row.owner_user_id,
            asset_row.filename,
            asset_row.mime_type,
            asset_row.sha256,
            storage_row.id AS storage_object_id,
            storage_row.storage_backend,
            storage_row.storage_key,
            storage_row.size_bytes,
            migration_source.id AS migration_source_object_id,
            migration_source.storage_backend AS migration_source_backend,
            migration_source.storage_key AS migration_source_key,
            migration_source.role AS migration_source_role,
            migration_source.state AS migration_source_state,
            migration_target.id AS migration_target_object_id,
            migration_target.storage_key AS migration_target_key,
            migration_target.role AS migration_target_role,
            migration_target.state AS migration_target_state,
            EXISTS (
              SELECT 1 FROM asset_usage usage_row
               WHERE usage_row.asset_id=asset_row.id
                 AND usage_row.project_id IS DISTINCT FROM $1
                 AND usage_row.consumer IS DISTINCT FROM
                     'project-purge-preserved-direct:' || $1::text
            ) AS shared
       FROM assets asset_row
       LEFT JOIN asset_storage_objects storage_row
         ON storage_row.asset_id=asset_row.id
        AND storage_row.state <> 'deleted'
        AND storage_row.role NOT LIKE $2
        AND storage_row.role NOT LIKE $3
       LEFT JOIN LATERAL (
         SELECT object_row.id, object_row.storage_backend, object_row.storage_key,
                object_row.role, object_row.state
           FROM asset_storage_objects object_row
          WHERE object_row.asset_id=asset_row.id AND object_row.role LIKE $4
          ORDER BY object_row.id DESC LIMIT 1
       ) migration_source ON TRUE
       LEFT JOIN LATERAL (
         SELECT object_row.id, object_row.storage_key, object_row.role, object_row.state
           FROM asset_storage_objects object_row
          WHERE object_row.asset_id=asset_row.id
            AND object_row.role LIKE $5
            AND object_row.state <> 'deleted'
          ORDER BY object_row.id DESC LIMIT 1
       ) migration_target ON TRUE
      WHERE asset_row.project_id=$1
      ORDER BY asset_row.id, storage_row.id`,
    [
      projectId,
      LEGACY_MIGRATION_TARGET_ROLE_PREFIX + "%",
      LEGACY_MIGRATION_SOURCE_ROLE_PREFIX + "%",
      LEGACY_MIGRATION_SOURCE_ROLE_PREFIX + "%",
      LEGACY_MIGRATION_TARGET_ROLE_PREFIX + "%",
    ],
  );
  const assetTargets = assetResult.rows
    .filter((row): row is typeof row & { storage_backend: string; storage_key: string } =>
      Boolean(row.storage_backend && row.storage_key),
    )
    .map((row) => ({
      assetId: row.asset_id,
      ownerUserId: row.owner_user_id,
      shared: row.shared,
      storageObjectId: row.storage_object_id ?? undefined,
      storageBackend: row.storage_backend,
      storageKey: row.storage_key,
      sizeBytes: Number(row.size_bytes ?? 0),
      filename: row.filename,
      mimeType: row.mime_type,
      sha256: row.sha256,
      inventoryStorageBackend: row.migration_source_backend ?? row.storage_backend,
      inventoryStorageKey: row.migration_source_key ?? row.storage_key,
      migrationSourceObjectId: row.migration_source_object_id,
      migrationSourceKey: row.migration_source_key,
      migrationSourceRole: row.migration_source_role,
      migrationSourceState: row.migration_source_state,
      migrationTargetObjectId: row.migration_target_object_id,
      migrationTargetKey: row.migration_target_key,
      migrationTargetRole: row.migration_target_role,
      migrationTargetState: row.migration_target_state,
    }));

  const uploadResult = await pool.query<{ object_path: string; shared: boolean }>(
    `SELECT upload_row.object_path,
            (
              EXISTS (
                SELECT 1 FROM project_uploads other_upload
                 WHERE other_upload.id <> upload_row.id
                   AND other_upload.object_path=upload_row.object_path
                   AND other_upload.project_id IS DISTINCT FROM $1
              )
              OR EXISTS (
                SELECT 1
                  FROM asset_storage_objects storage_row
                  JOIN assets asset_row ON asset_row.id=storage_row.asset_id
                 WHERE storage_row.storage_key=upload_row.object_path
                   AND storage_row.state <> 'deleted'
                   AND (
                     asset_row.project_id IS DISTINCT FROM $1
                     OR EXISTS (
                       SELECT 1 FROM asset_usage usage_row
                        WHERE usage_row.asset_id=asset_row.id
                          AND usage_row.project_id IS DISTINCT FROM $1
                          AND usage_row.consumer IS DISTINCT FROM
                              'project-purge-preserved-direct:' || $1::text
                     )
                   )
              )
              OR EXISTS (
                SELECT 1 FROM generated_images image_row
                 WHERE image_row.storage_key=upload_row.object_path
                   AND image_row.deleted_at IS NULL
                   AND image_row.project_id IS DISTINCT FROM $1
              )
            ) AS shared
       FROM project_uploads upload_row
      WHERE upload_row.project_id=$1
      ORDER BY upload_row.id`,
    [projectId],
  );
  const snapshotResult = await pool.query<{ object_key: string }>(
    `SELECT object_key FROM db_snapshots
      WHERE project_id=$1 AND object_key IS NOT NULL ORDER BY id`,
    [projectId],
  );
  const legacyImageResult = await pool.query<{
    storage_key: string;
    full_shared: boolean;
    thumbnail_shared: boolean;
  }>(
    `SELECT image_row.storage_key,
            (
              EXISTS (
                SELECT 1 FROM generated_images other_image
                 WHERE other_image.id <> image_row.id
                   AND other_image.storage_key=image_row.storage_key
                   AND other_image.deleted_at IS NULL
                   AND other_image.project_id IS DISTINCT FROM $1
              )
              OR EXISTS (
                SELECT 1
                  FROM asset_storage_objects storage_row
                  JOIN assets asset_row ON asset_row.id=storage_row.asset_id
                 WHERE storage_row.storage_key=image_row.storage_key
                   AND storage_row.state <> 'deleted'
                   AND (
                     asset_row.project_id IS DISTINCT FROM $1
                     OR EXISTS (
                       SELECT 1 FROM asset_usage usage_row
                        WHERE usage_row.asset_id=asset_row.id
                          AND usage_row.project_id IS DISTINCT FROM $1
                          AND usage_row.consumer IS DISTINCT FROM
                              'project-purge-preserved-direct:' || $1::text
                     )
                   )
              )
            ) AS full_shared,
            (
              EXISTS (
                SELECT 1 FROM generated_images other_image
                 WHERE other_image.id <> image_row.id
                   AND other_image.storage_key=image_row.storage_key
                   AND other_image.deleted_at IS NULL
                   AND other_image.project_id IS DISTINCT FROM $1
              )
              OR EXISTS (
                SELECT 1
                  FROM asset_storage_objects storage_row
                  JOIN assets asset_row ON asset_row.id=storage_row.asset_id
                 WHERE storage_row.storage_key=regexp_replace(
                         image_row.storage_key, '/full\\.webp$', '/thumb.webp'
                       )
                   AND storage_row.state <> 'deleted'
                   AND (
                     asset_row.project_id IS DISTINCT FROM $1
                     OR EXISTS (
                       SELECT 1 FROM asset_usage usage_row
                        WHERE usage_row.asset_id=asset_row.id
                          AND usage_row.project_id IS DISTINCT FROM $1
                          AND usage_row.consumer IS DISTINCT FROM
                              'project-purge-preserved-direct:' || $1::text
                     )
                   )
              )
            ) AS thumbnail_shared
       FROM generated_images image_row
      WHERE image_row.project_id=$1
        AND image_row.asset_id IS NULL
        AND image_row.storage_key IS NOT NULL
      ORDER BY image_row.id`,
    [projectId],
  );
  const addonResult = await pool.query<{ active_count: number }>(
    `SELECT COUNT(*)::integer AS active_count
       FROM managed_addons
      WHERE project_id=$1 AND (status <> 'removed' OR removed_at IS NULL)`,
    [projectId],
  );
  const tableCounts = await countProjectReferences(projectId, catalog);
  const neonProjectIds = [
    ...new Set([
      project.neon_project_id,
      project.db_connection_id,
      previewAllocation?.providerProjectId,
    ]),
  ]
    .filter((value): value is string => Boolean(value && !value.startsWith("local-")))
    .sort();
  const legacyGeneratedImageTargets = legacyImageResult.rows.flatMap<LegacyGeneratedImageTarget>(
    (row): LegacyGeneratedImageTarget[] => {
      const backend: LegacyGeneratedImageTarget["storageBackend"] = /^[A-Za-z]:[\\/]/u.test(
        row.storage_key,
      )
        ? "dev-file"
        : "r2";
      if (backend === "dev-file") {
        return [{ storageKey: row.storage_key, storageBackend: backend, shared: false }];
      }
      const thumbnail = row.storage_key.endsWith("/full.webp")
        ? row.storage_key.replace(/\/full\.webp$/u, "/thumb.webp")
        : null;
      return [
        { storageKey: row.storage_key, storageBackend: backend, shared: row.full_shared },
        ...(thumbnail
          ? [{ storageKey: thumbnail, storageBackend: backend, shared: row.thumbnail_shared }]
          : []),
      ];
    },
  );
  const digestInput = {
    projectId,
    tableCounts,
    assetObjects: assetTargets.map((target) => ({
      assetId: target.assetId,
      backend: target.inventoryStorageBackend ?? target.storageBackend,
      storageKey: target.inventoryStorageKey ?? target.storageKey,
      shared: target.shared,
    })),
    legacyImageObjects: legacyGeneratedImageTargets.map((target) => ({
      backend: target.storageBackend,
      storageKey: target.storageKey,
      shared: target.shared,
    })),
    uploadObjects: uploadResult.rows.map((row) => ({
      objectPath: row.object_path,
      shared: row.shared,
    })),
    snapshotObjects: snapshotResult.rows.map((row) => row.object_key),
    neonCount: neonProjectIds.length,
    legacyImageCount: legacyGeneratedImageTargets.length,
    activeAddonCount: Number(addonResult.rows[0]?.active_count ?? 0),
  };
  const inventory: ProjectPurgeResourceInventory = {
    projectId,
    ownerId: project.owner_id,
    projectName: project.name,
    deletedAt: project.deleted_at,
    retirementOperationId: project.retirement_operation_id,
    retirementProgress: project.retirement_progress,
    neonProjectIds,
    productionNeonProjectName: `mf-project-${projectId}`,
    previewNeonProjectName: `mf-preview-${projectId}`,
    previewDatabase,
    assetTargets,
    legacyGeneratedImageTargets,
    uploadTargets: uploadResult.rows.map((row) => ({
      objectPath: row.object_path,
      shared: row.shared,
    })),
    snapshotObjectKeys: snapshotResult.rows.map((row) => row.object_key),
    tableCounts,
    activeAddonCount: Number(addonResult.rows[0]?.active_count ?? 0),
    digestSha256: digest(digestInput),
  };
  if (await migrateRetainedLegacyAssetsForPurge(inventory, signal)) {
    return inventoryProjectPurgeResources(projectId, signal);
  }
  return inventory;
}

async function deleteLegacyObjectAndProveAbsent(
  objectPath: string,
  signal?: AbortSignal,
  expectedGeneration?: string,
): Promise<void> {
  signal?.throwIfAborted();
  const storage = new ObjectStorageService();
  try {
    const file = await storage.getObjectEntityFile(objectPath);
    const snapshot = await readLegacyProviderSnapshot(file, signal);
    if (expectedGeneration && snapshot.generation !== expectedGeneration) {
      throw new Error("project_purge_asset_storage_migration_source_changed");
    }
    await withLegacyProviderDeadline(
      () =>
        file.delete({
          ignoreNotFound: true,
          ifGenerationMatch: snapshot.generation,
        }),
      signal,
    );
    signal?.throwIfAborted();
  } catch (error) {
    if (!(error instanceof ObjectNotFoundError)) throw error;
  }
  try {
    signal?.throwIfAborted();
    await storage.getObjectEntityFile(objectPath);
    throw new Error("project_purge_asset_release_failed");
  } catch (error) {
    if (error instanceof ObjectNotFoundError) return;
    throw error;
  }
}

async function deleteStorageTargetAndProveAbsent(
  target: Pick<ProjectAssetStorageTarget, "storageBackend" | "storageKey">,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (target.storageBackend === "r2") {
    if (signal) await deleteAssetObject(target.storageKey, signal);
    else await deleteAssetObject(target.storageKey);
    const present = signal
      ? await headAssetObject(target.storageKey, signal)
      : await headAssetObject(target.storageKey);
    if (present !== null) {
      throw new Error("project_purge_asset_release_failed");
    }
    return;
  }
  if (target.storageBackend === "legacy-object") {
    await deleteLegacyObjectAndProveAbsent(target.storageKey, signal);
    return;
  }
  if (target.storageBackend === "dev-file") {
    await unlink(target.storageKey).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return;
  }
  if (target.storageBackend === "ora-db") {
    throw new Error("project_purge_asset_release_failed");
  }
  throw new Error("project_purge_asset_release_failed");
}

/**
 * Serialize attachment against deletion on the asset row. The asset-usage
 * trigger takes a share lock and accepts only `ready`; once this transaction
 * changes the row to `deleting`, a later attachment is structurally refused.
 * A writer that reached the row first commits before our second-statement
 * reference check and is therefore observed.
 */
type PurgeImageStorageAlias = {
  id: number;
  asset_id: number;
  storage_key: string | null;
  file_url: string | null;
  thumbnail_url: string | null;
  resolved_storage_keys: string[];
};

type PurgeStorageRow = {
  id: number;
  asset_id: number;
  storage_key: string;
  storage_backend: string;
};

async function readPurgeImageStorageAliases(
  client: PoolClient,
  assetIds: readonly number[],
): Promise<PurgeImageStorageAlias[]> {
  const result = await client.query<PurgeImageStorageAlias>(
    `/* purge-image-storage-aliases */
     SELECT image.id, image.asset_id, image.storage_key, image.file_url, image.thumbnail_url,
            ARRAY(
              SELECT resolved.storage_key
                FROM public.resolve_durable_storage_keys(jsonb_build_object(
                  'storage_key', image.storage_key,
                  'file_url', image.file_url,
                  'thumbnail_url', image.thumbnail_url
                )) AS resolved(storage_key)
            ) AS resolved_storage_keys
       FROM generated_images image
      WHERE image.asset_id=ANY($1::integer[])
        AND image.deleted_at IS NULL
      ORDER BY image.id`,
    [assetIds],
  );
  return result.rows;
}

function purgeImageStorageKeys(aliases: readonly PurgeImageStorageAlias[]): string[] {
  const keys = new Set<string>();
  const add = (key: string) => {
    keys.add(key);
    if (key.endsWith("/full.webp")) keys.add(key.replace(/\/full\.webp$/u, "/thumb.webp"));
  };
  for (const alias of aliases) {
    if (alias.storage_key) add(alias.storage_key);
    // Share the database guard's parser and namespace coverage. These are
    // retention candidates, never provider ownership or product authority.
    for (const key of alias.resolved_storage_keys ?? []) if (key) add(key);
  }
  return [...keys];
}

function sameLockedStorageRow(row: PurgeStorageRow, locked: readonly PurgeStorageRow[]): boolean {
  return locked.some(
    (previous) =>
      previous.id === row.id &&
      previous.asset_id === row.asset_id &&
      previous.storage_key === row.storage_key &&
      previous.storage_backend === row.storage_backend,
  );
}

async function checkPurgeImageStorageReferences(
  client: PoolClient,
  projectId: number,
  productScope: string | null,
  registeredKeys: ReadonlySet<string>,
  aliases: readonly PurgeImageStorageAlias[],
): Promise<boolean> {
  let referenced = false;
  for (const key of purgeImageStorageKeys(aliases)) {
    if (
      !(await hasSurvivingObjectReference(projectId, key, (statement, values) =>
        client.query<{ shared: boolean }>(statement, values),
      ))
    )
      continue;
    if (!isProductScope(productScope)) throw new Error("project_purge_asset_origin_unresolved");
    // A historical alias is not authority to adopt an unregistered provider
    // object. Keep the mapping and bytes until ownership is reconciled.
    if (!registeredKeys.has(key)) throw new Error("project_purge_asset_release_failed");
    referenced = true;
  }
  return referenced;
}

async function claimAssetTargetForPhysicalDeletion(
  projectId: number,
  target: ProjectAssetStorageTarget,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    // The second statement must see an attachment writer that committed while
    // the row lock was waiting. Pin the isolation level instead of trusting a
    // database/role default that could be REPEATABLE READ.
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const locked = await client.query<{
      state: string;
      storage_key: string;
      product_scope: string | null;
    }>(
      `/* purge-asset-row-lock */ SELECT state, storage_key, product_scope FROM assets
        WHERE id=$2 AND project_id=$1
        FOR UPDATE`,
      [projectId, target.assetId],
    );
    const state = locked.rows[0]?.state;
    if (!state || !["reserved", "uploading", "ready", "deleting", "rejected"].includes(state)) {
      throw new Error("project_purge_asset_release_failed");
    }
    const storageObjects = await client.query<PurgeStorageRow>(
      `/* purge-asset-storage-lock */
       SELECT id, asset_id, storage_key, storage_backend
         FROM asset_storage_objects
        WHERE asset_id=$1 AND state <> 'deleted'
        ORDER BY asset_id, storage_key COLLATE "C", storage_backend FOR UPDATE`,
      [target.assetId],
    );
    const initialAliases = await readPurgeImageStorageAliases(client, [target.assetId]);
    const registeredKeys = new Set(
      [
        locked.rows[0]!.storage_key,
        target.storageKey,
        ...storageObjects.rows.map((row) => row.storage_key),
      ].filter(Boolean),
    );
    const orderedKeys = await client.query<{ storage_key: string }>(
      `/* purge-asset-key-order */
       SELECT storage_key FROM (
         SELECT DISTINCT key_row.storage_key COLLATE "C" AS storage_key
           FROM unnest($1::text[]) AS key_row(storage_key)
       ) ordered_keys ORDER BY storage_key COLLATE "C"`,
      [[...registeredKeys, ...purgeImageStorageKeys(initialAliases)]],
    );
    const storageKeys = orderedKeys.rows.map((row) => row.storage_key);
    const lockedKeys = new Set(storageKeys);
    for (const storageKey of storageKeys) {
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('nabuflow:durable-object:' || $1, 0)
         )`,
        [storageKey],
      );
    }
    const imageLocks = await client.query<{ id: number }>(
      `/* purge-asset-image-metadata */
       SELECT id FROM generated_images WHERE id=ANY($1::integer[]) ORDER BY id FOR UPDATE`,
      [initialAliases.map((alias) => alias.id)],
    );
    await client.query(
      `/* purge-asset-upload-metadata */
       SELECT id FROM project_uploads WHERE object_path=ANY($1::text[]) ORDER BY id FOR UPDATE`,
      [storageKeys],
    );
    const refreshedStorage = await client.query<PurgeStorageRow>(
      `/* purge-asset-storage-refresh */
       SELECT id, asset_id, storage_key, storage_backend FROM asset_storage_objects
        WHERE asset_id=$1 AND state <> 'deleted'`,
      [target.assetId],
    );
    const aliases = await readPurgeImageStorageAliases(client, [target.assetId]);
    const lockedImageIds = new Set(imageLocks.rows.map((row) => row.id));
    if (
      refreshedStorage.rows.some((row) => !sameLockedStorageRow(row, storageObjects.rows)) ||
      aliases.some((alias) => !lockedImageIds.has(alias.id)) ||
      purgeImageStorageKeys(aliases).some((key) => !lockedKeys.has(key))
    ) {
      throw new Error("project_purge_asset_release_failed");
    }
    await checkPurgeImageStorageReferences(
      client,
      projectId,
      locked.rows[0]!.product_scope,
      registeredKeys,
      aliases,
    );
    const existingClaim = await client.query(
      `SELECT 1 FROM durable_asset_deletion_claims WHERE storage_key=ANY($1::text[])`,
      [storageKeys],
    );
    await canonicalizeSurvivingAssetAliases(client, projectId, target.assetId);
    const queryReference: ProjectPurgeBooleanQuery = (statement, values) =>
      client.query<{ shared: boolean }>(statement, values);
    const hasDurableReference = await hasSurvivingAssetReference(
      projectId,
      target.assetId,
      queryReference,
    );
    let hasRawObjectReference = false;
    for (const storageKey of storageKeys) {
      if (await hasSurvivingObjectReference(projectId, storageKey, queryReference)) {
        hasRawObjectReference = true;
      }
    }
    if (hasDurableReference || hasRawObjectReference) {
      if (existingClaim.rowCount) {
        throw new Error("project_purge_asset_release_failed");
      }
      // A direct durable reference can outlive its source project even when an
      // older caller did not write asset_usage. Preserve a temporary physical
      // retention row so relational deletion rehomes the asset metadata together
      // with the provider bytes. The row-lock trigger makes this final scan
      // serializable against every covered writer.
      await client.query(
        `INSERT INTO asset_usage (asset_id, project_id, consumer)
         SELECT $1, NULL, 'project-purge-preserved-direct:' || $2::text
          WHERE NOT EXISTS (
            SELECT 1 FROM asset_usage
             WHERE asset_id=$1
               AND project_id IS NULL
               AND consumer='project-purge-preserved-direct:' || $2::text
          )`,
        [target.assetId, projectId],
      );
    }
    if (hasDurableReference || hasRawObjectReference) {
      await client.query("COMMIT");
      return false;
    }
    const claimed = await client.query(
      `UPDATE assets
          SET state='deleting'
        WHERE id=$2 AND project_id=$1 AND state IN ('reserved','uploading','ready','deleting','rejected')`,
      [projectId, target.assetId],
    );
    const claimedStorage = await client.query(
      `UPDATE asset_storage_objects
          SET state='deleting'
        WHERE asset_id=$1 AND storage_key=$2 AND state <> 'deleted'`,
      [target.assetId, target.storageKey],
    );
    if (claimed.rowCount !== 1 || claimedStorage.rowCount !== 1) {
      throw new Error("project_purge_asset_release_failed");
    }
    await client.query(
      `INSERT INTO durable_asset_deletion_claims (
         storage_key, claim_kind, retired_project_id, retired_asset_id
       ) VALUES ($1, 'project-purge-asset', $2, $3)
       ON CONFLICT (storage_key) DO NOTHING`,
      [target.storageKey, projectId, target.assetId],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type ProjectPurgeBooleanQuery = (
  statement: string,
  values: unknown[],
) => Promise<{ rows: Array<{ shared: boolean }> }>;

async function hasSurvivingAssetReference(
  projectId: number,
  assetId: number,
  query: ProjectPurgeBooleanQuery = (statement, values) =>
    pool.query<{ shared: boolean }>(statement, values),
): Promise<boolean> {
  const result = await query(
    `SELECT public.durable_asset_reference_exists($2, $1, NULL) AS shared`,
    [projectId, assetId],
  );
  if (typeof result.rows[0]?.shared !== "boolean") {
    throw new Error("project_purge_asset_release_failed");
  }
  return result.rows[0].shared;
}

/** Last-moment legacy/reference check for every physical object without an asset-row lock. */
async function hasSurvivingObjectReference(
  projectId: number,
  storageKey: string,
  query: ProjectPurgeBooleanQuery = (statement, values) =>
    pool.query<{ shared: boolean }>(statement, values),
  ignoredStorageObjectId: number | null = null,
): Promise<boolean> {
  const result = await query(
    `SELECT (
       EXISTS (
         SELECT 1 FROM project_uploads upload_row
          WHERE upload_row.object_path=$2
            AND upload_row.project_id IS DISTINCT FROM $1
       )
       OR EXISTS (
         SELECT 1 FROM chat_messages message_row
          WHERE message_row.project_id IS DISTINCT FROM $1
            AND position($2 in coalesce(message_row.attachments::text, '')) > 0
       )
       OR EXISTS (
         SELECT 1 FROM agent_tasks task_row
          WHERE task_row.project_id IS DISTINCT FROM $1
            AND (
              position($2 in coalesce(task_row.attachments::text, '')) > 0
              OR position($2 in coalesce(task_row.report::text, '')) > 0
              OR position($2 in coalesce(task_row.staging_snapshot::text, '')) > 0
            )
       )
       OR EXISTS (
         SELECT 1
           FROM agent_tool_calls call_row
          WHERE call_row.project_id IS DISTINCT FROM $1
            AND (
              position($2 in coalesce(call_row.stdout_preview, '')) > 0
              OR position($2 in coalesce(call_row.args_summary, '')) > 0
            )
       )
       OR EXISTS (
         SELECT 1 FROM zero_prompt_queue_items queue_row
          WHERE queue_row.project_id IS DISTINCT FROM $1
            AND (
              position($2 in coalesce(queue_row.asset_ids::text, '')) > 0
              OR position($2 in coalesce(queue_row.current_text, '')) > 0
            )
       )
       OR EXISTS (
         SELECT 1 FROM knowledge_entries knowledge_row
          WHERE knowledge_row.project_id IS DISTINCT FROM $1
            AND position($2 in coalesce(knowledge_row.annotation, '')) > 0
       )
       OR EXISTS (
         SELECT 1 FROM project_files file_row
          WHERE file_row.project_id IS DISTINCT FROM $1
            AND position($2 in file_row.content) > 0
       )
       OR EXISTS (
         SELECT 1 FROM project_versions version_row
          WHERE version_row.project_id IS DISTINCT FROM $1
            AND position($2 in coalesce(version_row.files_snapshot::text, '')) > 0
       )
       OR EXISTS (
         SELECT 1 FROM canvas_variants variant_row
          WHERE variant_row.project_id IS DISTINCT FROM $1
            AND position($2 in coalesce(variant_row.files::text, '')) > 0
       )
       OR EXISTS (
         SELECT 1 FROM canvas_variant_library library_row
          WHERE position($2 in coalesce(library_row.files::text, '')) > 0
       )
       OR EXISTS (
         SELECT 1 FROM gallery_templates template_row
          WHERE position($2 in coalesce(template_row.files_snapshot::text, '')) > 0
       )
       OR EXISTS (
         SELECT 1 FROM agent_inbox inbox_row
          WHERE inbox_row.project_id IS DISTINCT FROM $1
            AND position($2 in coalesce(inbox_row.screenshot_url, '')) > 0
       )
       OR EXISTS (
         SELECT 1
           FROM task_events event_row
           JOIN agent_tasks task_row ON task_row.id=event_row.task_id
          WHERE task_row.project_id IS DISTINCT FROM $1
            AND (
              position($2 in event_row.message) > 0
              OR position($2 in coalesce(event_row.data::text, '')) > 0
            )
       )
       OR EXISTS (
         SELECT 1 FROM project_activity activity_row
          WHERE activity_row.project_id IS DISTINCT FROM $1
            AND position($2 in coalesce(activity_row.metadata::text, '')) > 0
       )
       OR EXISTS (
         SELECT 1 FROM visual_edit_changes edit_row
          WHERE edit_row.project_id IS DISTINCT FROM $1
            AND (
              position($2 in edit_row.before_content) > 0
              OR position($2 in edit_row.after_content) > 0
            )
       )
       OR EXISTS (
         SELECT 1 FROM generated_images image_row
          WHERE image_row.project_id IS DISTINCT FROM $1
            AND image_row.deleted_at IS NULL
            AND (
              image_row.storage_key=$2
              OR position($2 in coalesce(image_row.file_url, '')) > 0
              OR position($2 in coalesce(image_row.thumbnail_url, '')) > 0
              OR (image_row.storage_key LIKE '%/full.webp'
                  AND regexp_replace(image_row.storage_key, '/full\\.webp$', '/thumb.webp')=$2)
            )
       )
       OR EXISTS (
         SELECT 1
           FROM asset_storage_objects storage_row
           JOIN assets asset_row ON asset_row.id=storage_row.asset_id
          WHERE storage_row.storage_key=$2
            AND storage_row.state <> 'deleted'
            AND ($3::bigint IS NULL OR storage_row.id <> $3::bigint)
            AND (
              asset_row.project_id IS DISTINCT FROM $1
              OR EXISTS (
                SELECT 1 FROM asset_usage usage_row
                 WHERE usage_row.asset_id=asset_row.id
                   AND usage_row.project_id IS DISTINCT FROM $1
                   AND usage_row.consumer IS DISTINCT FROM
                       'project-purge-preserved-direct:' || $1::text
              )
            )
       )
       OR EXISTS (
         SELECT 1 FROM db_snapshots snapshot_row
          WHERE snapshot_row.object_key=$2
            AND snapshot_row.project_id IS DISTINCT FROM $1
       )
     ) AS shared`,
    [projectId, storageKey, ignoredStorageObjectId],
  );
  if (typeof result.rows[0]?.shared !== "boolean") {
    throw new Error("project_purge_asset_release_failed");
  }
  return result.rows[0].shared;
}

async function claimObjectTargetForPhysicalDeletion(
  projectId: number,
  storageKey: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('nabuflow:durable-object:' || $1, 0)
       )`,
      [storageKey],
    );
    const existingClaim = await client.query(
      `SELECT 1 FROM durable_asset_deletion_claims WHERE storage_key=$1`,
      [storageKey],
    );
    const queryReference: ProjectPurgeBooleanQuery = (statement, values) =>
      client.query<{ shared: boolean }>(statement, values);
    if (await hasSurvivingObjectReference(projectId, storageKey, queryReference)) {
      if (existingClaim.rowCount) {
        throw new Error("project_purge_asset_release_failed");
      }
      await client.query("COMMIT");
      return false;
    }
    await client.query(
      `INSERT INTO durable_asset_deletion_claims (
         storage_key, claim_kind, retired_project_id
       ) VALUES ($1, 'project-purge-object', $2)
       ON CONFLICT (storage_key) DO NOTHING`,
      [storageKey, projectId],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Provider deletion is sequential and idempotent to avoid request bursts. */
export async function releaseProjectAssetStorage(
  inventory: ProjectPurgeResourceInventory,
  cursor: ProjectPurgeAssetReleaseCursor = {
    assetIndex: 0,
    legacyImageIndex: 0,
    uploadIndex: 0,
  },
  limit = PROJECT_PURGE_RESOURCE_BATCH_SIZE,
  signal?: AbortSignal,
): Promise<{
  deletedObjects: number;
  detachedObjects: number;
  cursor: ProjectPurgeAssetReleaseCursor;
  complete: boolean;
}> {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > PROJECT_PURGE_RESOURCE_BATCH_SIZE ||
    ![cursor.assetIndex, cursor.legacyImageIndex, cursor.uploadIndex].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    cursor.assetIndex > inventory.assetTargets.length ||
    cursor.legacyImageIndex > inventory.legacyGeneratedImageTargets.length ||
    cursor.uploadIndex > inventory.uploadTargets.length ||
    (cursor.legacyImageIndex > 0 && cursor.assetIndex !== inventory.assetTargets.length) ||
    (cursor.uploadIndex > 0 &&
      (cursor.assetIndex !== inventory.assetTargets.length ||
        cursor.legacyImageIndex !== inventory.legacyGeneratedImageTargets.length))
  ) {
    throw new Error("project_purge_asset_release_failed");
  }
  let deletedObjects = 0;
  let detachedObjects = 0;
  let remaining = limit;
  let assetIndex = cursor.assetIndex;
  let legacyImageIndex = cursor.legacyImageIndex;
  let uploadIndex = cursor.uploadIndex;
  while (assetIndex < inventory.assetTargets.length && remaining > 0) {
    signal?.throwIfAborted();
    const target = inventory.assetTargets[assetIndex]!;
    if (!(await claimAssetTargetForPhysicalDeletion(inventory.projectId, target))) {
      detachedObjects += 1;
    } else {
      await deleteStorageTargetAndProveAbsent(target, signal);
      deletedObjects += 1;
    }
    assetIndex += 1;
    remaining -= 1;
  }
  while (
    assetIndex >= inventory.assetTargets.length &&
    legacyImageIndex < inventory.legacyGeneratedImageTargets.length &&
    remaining > 0
  ) {
    signal?.throwIfAborted();
    const target = inventory.legacyGeneratedImageTargets[legacyImageIndex]!;
    if (!(await claimObjectTargetForPhysicalDeletion(inventory.projectId, target.storageKey))) {
      detachedObjects += 1;
    } else {
      await deleteStorageTargetAndProveAbsent(
        {
          storageBackend: target.storageBackend,
          storageKey: target.storageKey,
        },
        signal,
      );
      deletedObjects += 1;
    }
    legacyImageIndex += 1;
    remaining -= 1;
  }
  while (
    assetIndex >= inventory.assetTargets.length &&
    legacyImageIndex >= inventory.legacyGeneratedImageTargets.length &&
    uploadIndex < inventory.uploadTargets.length &&
    remaining > 0
  ) {
    signal?.throwIfAborted();
    const target = inventory.uploadTargets[uploadIndex]!;
    if (!(await claimObjectTargetForPhysicalDeletion(inventory.projectId, target.objectPath))) {
      detachedObjects += 1;
    } else {
      await deleteLegacyObjectAndProveAbsent(target.objectPath, signal);
      deletedObjects += 1;
    }
    uploadIndex += 1;
    remaining -= 1;
  }
  const nextCursor = { assetIndex, legacyImageIndex, uploadIndex };
  return {
    deletedObjects,
    detachedObjects,
    cursor: nextCursor,
    complete:
      assetIndex >= inventory.assetTargets.length &&
      legacyImageIndex >= inventory.legacyGeneratedImageTargets.length &&
      uploadIndex >= inventory.uploadTargets.length,
  };
}

export async function releaseProjectSnapshotStorage(
  inventory: ProjectPurgeResourceInventory,
  cursor: ProjectPurgeSnapshotReleaseCursor = { snapshotIndex: 0 },
  limit = PROJECT_PURGE_RESOURCE_BATCH_SIZE,
  signal?: AbortSignal,
): Promise<{
  removed: number;
  detached: number;
  cursor: ProjectPurgeSnapshotReleaseCursor;
  complete: boolean;
}> {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > PROJECT_PURGE_RESOURCE_BATCH_SIZE ||
    !Number.isSafeInteger(cursor.snapshotIndex) ||
    cursor.snapshotIndex < 0 ||
    cursor.snapshotIndex > inventory.snapshotObjectKeys.length
  ) {
    throw new Error("project_purge_snapshot_release_failed");
  }
  let removed = 0;
  let detached = 0;
  let snapshotIndex = cursor.snapshotIndex;
  const end = Math.min(inventory.snapshotObjectKeys.length, snapshotIndex + limit);
  while (snapshotIndex < end) {
    signal?.throwIfAborted();
    const objectKey = inventory.snapshotObjectKeys[snapshotIndex]!;
    if (!(await claimObjectTargetForPhysicalDeletion(inventory.projectId, objectKey))) {
      detached += 1;
    } else {
      if (!(await deleteSnapshotBlob(objectKey, signal))) {
        throw new Error("project_purge_snapshot_release_failed");
      }
      if (await snapshotBlobExists(objectKey, signal)) {
        throw new Error("project_purge_snapshot_release_failed");
      }
      removed += 1;
    }
    snapshotIndex += 1;
  }
  return {
    removed,
    detached,
    cursor: { snapshotIndex },
    complete: snapshotIndex >= inventory.snapshotObjectKeys.length,
  };
}

async function readSealedProductionDatabaseAdmission(
  client: PoolClient,
  projectId: number,
  allocationIdentity: string,
): Promise<ReturnType<typeof productionDatabaseSealedAdmissionSchema.parse>> {
  const result = await client.query<{
    project_id: number;
    registration_epoch: string;
    birth_token: string;
    birth_registered: boolean;
    allocation_identity: string | null;
    state: string;
    seal_id: string | null;
  }>(
    `SELECT project_id, registration_epoch, birth_token, birth_registered,
            allocation_identity, state, seal_id
       FROM production_database_admission_receipts
      WHERE project_id=$1 FOR UPDATE`,
    [projectId],
  );
  const row = result.rows[0];
  const admission = productionDatabaseSealedAdmissionSchema.safeParse({
    format: "nabuflow.production-database-admission/v1",
    issuer: "nabuflow-api",
    audience: "production",
    projectId: row?.project_id,
    allocationIdentity: row?.allocation_identity,
    registrationEpoch: row?.registration_epoch,
    birthToken: row?.birth_token,
    receiptId: row?.seal_id,
    birthRegistered: row?.birth_registered,
    assertion: row?.state,
  });
  if (
    result.rows.length !== 1 ||
    !admission.success ||
    admission.data.projectId !== projectId ||
    admission.data.allocationIdentity !== allocationIdentity
  ) {
    throw new Error("project_purge_production_database_admission_unverified");
  }
  return admission.data;
}

type FinalPurgeAsset = {
  id: number;
  project_id: number | null;
  state: string;
  storage_key: string;
  storage_backend: string;
  product_scope: string | null;
};

type FinalPurgeAlias = {
  kind: "image" | "upload";
  id: number;
  alias: string;
  asset_id: number | null;
  storage_key: string | null;
  active: boolean;
};

type FinalPurgeCleanupTarget = {
  assetId: number;
  storageObjectId: number | null;
  storageBackend: string;
  storageKey: string;
};

type FinalFenceReconciliationCursor = {
  removedStorageKeys: Set<string>;
  removedProviderDetachedStorageKeys: Set<string>;
  latePreservedStorageKeys: Set<string>;
};

const FINAL_FENCE_RECONCILIATION_SCHEMA = "project-purge-final-fence-reconciliation/v1";

function readFinalFenceReconciliationCursor(
  progress: Record<string, unknown> | null,
): FinalFenceReconciliationCursor {
  const empty = (): FinalFenceReconciliationCursor => ({
    removedStorageKeys: new Set(),
    removedProviderDetachedStorageKeys: new Set(),
    latePreservedStorageKeys: new Set(),
  });
  const raw = progress?.finalFenceReconciliation;
  if (raw === undefined) return empty();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("project_purge_relational_delete_failed");
  }
  const value = raw as Record<string, unknown>;
  const readKeys = (field: string): Set<string> => {
    const keys = value[field];
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string" || !key)) {
      throw new Error("project_purge_relational_delete_failed");
    }
    return new Set(keys as string[]);
  };
  if (value.schema !== FINAL_FENCE_RECONCILIATION_SCHEMA) {
    throw new Error("project_purge_relational_delete_failed");
  }
  const cursor = {
    removedStorageKeys: readKeys("removedStorageKeys"),
    removedProviderDetachedStorageKeys: readKeys("removedProviderDetachedStorageKeys"),
    latePreservedStorageKeys: readKeys("latePreservedStorageKeys"),
  };
  if (
    [...cursor.removedProviderDetachedStorageKeys].some(
      (key) => !cursor.removedStorageKeys.has(key),
    ) ||
    [...cursor.latePreservedStorageKeys].some((key) => cursor.removedStorageKeys.has(key))
  ) {
    throw new Error("project_purge_relational_delete_failed");
  }
  return cursor;
}

function writeFinalFenceReconciliationCursor(cursor: FinalFenceReconciliationCursor) {
  return {
    schema: FINAL_FENCE_RECONCILIATION_SCHEMA,
    removedStorageKeys: [...cursor.removedStorageKeys].sort(),
    removedProviderDetachedStorageKeys: [...cursor.removedProviderDetachedStorageKeys].sort(),
    latePreservedStorageKeys: [...cursor.latePreservedStorageKeys].sort(),
  };
}

const FINAL_PURGE_ASSET_PREDICATE = `
  asset_row.project_id=$1
  OR EXISTS (
    SELECT 1 FROM generated_images image
     WHERE image.project_id=$1
       AND image.deleted_at IS NULL
       AND image.asset_id=asset_row.id
  )
  OR EXISTS (
    SELECT 1 FROM project_uploads upload
     WHERE upload.project_id=$1 AND upload.object_path=asset_row.storage_key
  )`;

async function readFinalPurgeAliases(
  client: PoolClient,
  projectId: number,
): Promise<FinalPurgeAlias[]> {
  const result = await client.query<FinalPurgeAlias>(
    `/* purge-final-alias-plan */
     SELECT 'image'::text AS kind, image.id,
             '/api/images/' || image.id::text || '/file' AS alias,
             image.asset_id, image.storage_key, image.deleted_at IS NULL AS active
       FROM generated_images image WHERE image.project_id=$1
     UNION ALL
     SELECT 'upload'::text, upload.id,
             '/api/projects/' || upload.project_id::text || '/uploads/' ||
               upload.id::text || '/content',
             asset.id, upload.object_path, TRUE
       FROM project_uploads upload
       LEFT JOIN assets asset
         ON asset.project_id=upload.project_id
        AND asset.source='legacy-project-upload'
        AND asset.storage_key=upload.object_path
      WHERE upload.project_id=$1`,
    [projectId],
  );
  return result.rows;
}

function finalAliasStorageKeys(aliases: readonly FinalPurgeAlias[]): string[] {
  return aliases.flatMap((alias) =>
    !alias.active || !alias.storage_key
      ? []
      : alias.kind === "image" && alias.storage_key.endsWith("/full.webp")
        ? [alias.storage_key, alias.storage_key.replace(/\/full\.webp$/u, "/thumb.webp")]
        : [alias.storage_key],
  );
}

/**
 * An earlier provider-release checkpoint cannot close the alias-writer window.
 * Keep these locks through metadata deletion, rehome and the project DELETE.
 * Match writer order: lifecycle, assets, storage rows, physical keys, metadata.
 * Never take a newly discovered earlier lock after waiting on a later one.
 */
async function fenceFinalPurgeAssets(
  client: PoolClient,
  projectId: number,
): Promise<{
  imageIds: Set<number>;
  uploadIds: Set<number>;
  cleanupTargets: FinalPurgeCleanupTarget[];
  newlyPreservedKeys: Set<string>;
}> {
  const assets = await client.query<FinalPurgeAsset>(
    `/* purge-final-assets-lock */
     SELECT asset_row.id, asset_row.project_id, asset_row.state,
            asset_row.storage_key, asset_row.product_scope, asset_row.storage_backend
       FROM assets asset_row
      WHERE ${FINAL_PURGE_ASSET_PREDICATE}
      ORDER BY asset_row.id FOR UPDATE OF asset_row`,
    [projectId],
  );
  const assetIds = assets.rows.map((asset) => asset.id);
  const lockedAssets = new Map(assets.rows.map((asset) => [asset.id, asset]));
  const storage = await client.query<PurgeStorageRow>(
    `/* purge-final-storage-lock */
     SELECT id, asset_id, storage_key, storage_backend FROM asset_storage_objects
      WHERE asset_id=ANY($1::integer[]) AND state <> 'deleted'
      ORDER BY asset_id, storage_key COLLATE "C", storage_backend FOR UPDATE`,
    [assetIds],
  );
  const initialAliases = await readFinalPurgeAliases(client, projectId);
  const initialImageStorageAliases = await readPurgeImageStorageAliases(client, assetIds);
  const keys = await client.query<{ storage_key: string }>(
    `/* purge-final-key-order */
     SELECT storage_key FROM (
       SELECT DISTINCT key_row.storage_key COLLATE "C" AS storage_key
         FROM unnest($1::text[]) AS key_row(storage_key)
     ) ordered_keys ORDER BY storage_key COLLATE "C"`,
    [
      [
        ...assets.rows.map((asset) => asset.storage_key),
        ...storage.rows.map((object) => object.storage_key),
        ...finalAliasStorageKeys(initialAliases),
        ...purgeImageStorageKeys(initialImageStorageAliases),
      ],
    ],
  );
  const lockedKeys = new Set(keys.rows.map((row) => row.storage_key));
  for (const { storage_key: key } of keys.rows) {
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('nabuflow:durable-object:' || $1, 0)
       )`,
      [key],
    );
  }
  const images = await client.query<{ id: number }>(
    `/* purge-final-image-metadata */
     SELECT id FROM generated_images
      WHERE project_id=$1 OR id=ANY($2::integer[]) ORDER BY id FOR UPDATE`,
    [projectId, initialImageStorageAliases.map((alias) => alias.id)],
  );
  const uploads = await client.query<{ id: number }>(
    `/* purge-final-upload-metadata */
     SELECT id FROM project_uploads WHERE project_id=$1 ORDER BY id FOR UPDATE`,
    [projectId],
  );
  const imageIds = new Set(images.rows.map((row) => row.id));
  const uploadIds = new Set(uploads.rows.map((row) => row.id));

  // Separate READ COMMITTED statements see writers that committed during waits.
  const refreshedAssets = await client.query<FinalPurgeAsset>(
    `/* purge-final-assets-refresh */
     SELECT asset_row.id, asset_row.project_id, asset_row.state,
            asset_row.storage_key, asset_row.product_scope, asset_row.storage_backend
       FROM assets asset_row WHERE ${FINAL_PURGE_ASSET_PREDICATE}`,
    [projectId],
  );
  const refreshedStorage = await client.query<PurgeStorageRow>(
    `/* purge-final-storage-refresh */
     SELECT id, asset_id, storage_key, storage_backend FROM asset_storage_objects
      WHERE asset_id=ANY($1::integer[]) AND state <> 'deleted'`,
    [assetIds],
  );
  const aliases = await readFinalPurgeAliases(client, projectId);
  const imageStorageAliases = await readPurgeImageStorageAliases(client, assetIds);
  if (
    refreshedAssets.rows.some(
      (asset) => !lockedAssets.has(asset.id) || !lockedKeys.has(asset.storage_key),
    ) ||
    refreshedStorage.rows.some(
      (object) =>
        !lockedKeys.has(object.storage_key) || !sameLockedStorageRow(object, storage.rows),
    ) ||
    imageStorageAliases.some((alias) => !imageIds.has(alias.id)) ||
    purgeImageStorageKeys(imageStorageAliases).some((key) => !lockedKeys.has(key)) ||
    finalAliasStorageKeys(aliases).some((key) => !lockedKeys.has(key)) ||
    aliases.some(
      (alias) =>
        !(alias.kind === "image" ? imageIds : uploadIds).has(alias.id) ||
        (alias.asset_id !== null && !lockedAssets.has(alias.asset_id)),
    )
  ) {
    throw new Error("project_purge_asset_release_failed");
  }

  const queryReference: ProjectPurgeBooleanQuery = (statement, values) =>
    client.query<{ shared: boolean }>(statement, values);
  for (const asset of assets.rows) {
    await checkPurgeImageStorageReferences(
      client,
      projectId,
      asset.product_scope,
      new Set([
        asset.storage_key,
        ...refreshedStorage.rows
          .filter((row) => row.asset_id === asset.id)
          .map((row) => row.storage_key),
      ]),
      imageStorageAliases.filter((alias) => alias.asset_id === asset.id),
    );
  }
  for (const alias of aliases) {
    if (!alias.active) continue;
    const asset = alias.asset_id === null ? undefined : lockedAssets.get(alias.asset_id);
    if (!asset || asset.state !== "ready") {
      if (await hasSurvivingObjectReference(projectId, alias.alias, queryReference)) {
        throw new Error("project_purge_asset_release_failed");
      }
      continue;
    }
    await canonicalizeLockedAssetAliases(
      client,
      projectId,
      asset.id,
      asset.product_scope,
      asset.storage_backend,
      [alias],
    );
  }

  // Physical references are global, including other products and unknown origin.
  // This marker prevents a cascade; it is neither a grant nor a provenance edit.
  const preserved = await client.query<{ asset_id: number }>(
    `SELECT asset_id FROM asset_usage
      WHERE asset_id=ANY($1::integer[])
        AND project_id IS NULL
        AND consumer='project-purge-preserved-direct:' || $2::text
      ORDER BY asset_id FOR UPDATE`,
    [assetIds, projectId],
  );
  const preexistingPreservedAssetIds = new Set(preserved.rows.map((row) => row.asset_id));
  const cleanupTargets: FinalPurgeCleanupTarget[] = [];
  const cleanupByKey = new Map<string, FinalPurgeCleanupTarget>();
  const newlyPreservedKeys = new Set<string>();
  for (const asset of assets.rows) {
    if (asset.project_id !== projectId) continue;
    const assetKeys = [
      ...new Set([
        asset.storage_key,
        ...refreshedStorage.rows
          .filter((object) => object.asset_id === asset.id)
          .map((object) => object.storage_key),
        ...purgeImageStorageKeys(
          imageStorageAliases.filter((alias) => alias.asset_id === asset.id),
        ),
      ]),
    ];
    const canonicalAlias =
      asset.product_scope === "ora"
        ? `/api/ora/canonical-assets/${asset.id}/content`
        : `/api/assets/${asset.id}/content`;
    await assertCanonicalizationReferenceAuthority(client, projectId, asset.id, [
      { alias: canonicalAlias },
      ...assetKeys.map((alias) => ({ alias })),
    ]);
    const historicalUploadAliases = assetKeys
      .filter((key) =>
        /^\/objects\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
          key,
        ),
      )
      .map((alias) => ({ alias }));
    if (historicalUploadAliases.length > 0) {
      await canonicalizeLockedAssetAliases(
        client,
        projectId,
        asset.id,
        asset.product_scope,
        asset.storage_backend,
        historicalUploadAliases,
      );
    }
    let referenced = await hasSurvivingAssetReference(projectId, asset.id, queryReference);
    for (const key of assetKeys) {
      if (await hasSurvivingObjectReference(projectId, key, queryReference)) referenced = true;
    }
    if (!referenced) {
      if (!preexistingPreservedAssetIds.has(asset.id)) continue;
      if (asset.state !== "ready" && asset.state !== "deleting") {
        throw new Error("project_purge_asset_release_failed");
      }
      const targets = new Map<string, FinalPurgeCleanupTarget>();
      for (const object of refreshedStorage.rows.filter((row) => row.asset_id === asset.id)) {
        targets.set(object.storage_key, {
          assetId: asset.id,
          storageObjectId: object.id,
          storageBackend: object.storage_backend,
          storageKey: object.storage_key,
        });
      }
      if (!targets.has(asset.storage_key)) {
        targets.set(asset.storage_key, {
          assetId: asset.id,
          storageObjectId: null,
          storageBackend: asset.storage_backend,
          storageKey: asset.storage_key,
        });
      }
      for (const key of purgeImageStorageKeys(
        imageStorageAliases.filter((alias) => alias.asset_id === asset.id),
      )) {
        if (!targets.has(key)) {
          targets.set(key, {
            assetId: asset.id,
            storageObjectId: null,
            storageBackend: asset.storage_backend,
            storageKey: key,
          });
        }
      }
      if ([...targets.keys()].some((key) => !lockedKeys.has(key))) {
        throw new Error("project_purge_asset_release_failed");
      }
      const assetChanged = await client.query(
        `UPDATE assets SET state='deleting'
          WHERE id=$1 AND project_id=$2 AND state IN ('ready', 'deleting')`,
        [asset.id, projectId],
      );
      if (assetChanged.rowCount !== 1) {
        throw new Error("project_purge_asset_release_failed");
      }
      const storageObjectIds = [...targets.values()]
        .map((target) => target.storageObjectId)
        .filter((id): id is number => id !== null);
      if (storageObjectIds.length > 0) {
        const storageChanged = await client.query(
          `UPDATE asset_storage_objects SET state='deleting'
            WHERE id=ANY($1::bigint[]) AND asset_id=$2 AND state <> 'deleted'`,
          [storageObjectIds, asset.id],
        );
        if (storageChanged.rowCount !== storageObjectIds.length) {
          throw new Error("project_purge_asset_release_failed");
        }
      }
      for (const target of targets.values()) {
        const existingTarget = cleanupByKey.get(target.storageKey);
        if (existingTarget && existingTarget.assetId !== target.assetId) {
          throw new Error("project_purge_asset_release_failed");
        }
        const claim = await client.query(
          `INSERT INTO durable_asset_deletion_claims (
             storage_key, claim_kind, retired_project_id, retired_asset_id
           ) VALUES ($1, 'project-purge-preservation-reconcile', $2, $3)
           ON CONFLICT (storage_key) DO NOTHING`,
          [target.storageKey, projectId, target.assetId],
        );
        if (claim.rowCount !== 1) {
          const existing = await client.query<{
            claim_kind: string;
            retired_project_id: number | null;
            retired_asset_id: number | null;
          }>(
            `SELECT claim_kind, retired_project_id, retired_asset_id
               FROM durable_asset_deletion_claims WHERE storage_key=$1`,
            [target.storageKey],
          );
          if (
            existing.rows[0]?.claim_kind !== "project-purge-preservation-reconcile" ||
            existing.rows[0]?.retired_project_id !== projectId ||
            existing.rows[0]?.retired_asset_id !== target.assetId
          ) {
            throw new Error("project_purge_asset_release_failed");
          }
        }
        cleanupByKey.set(target.storageKey, target);
      }
      continue;
    }
    if (!isProductScope(asset.product_scope)) {
      throw new Error("project_purge_asset_origin_unresolved");
    }
    if (asset.state !== "ready") throw new Error("project_purge_asset_release_failed");
    const claim = await client.query(
      "SELECT 1 FROM durable_asset_deletion_claims WHERE storage_key=ANY($1::text[])",
      [assetKeys],
    );
    if (claim.rowCount) throw new Error("project_purge_asset_release_failed");
    await client.query(
      `INSERT INTO asset_usage (asset_id, project_id, consumer)
       VALUES ($1, NULL, 'project-purge-preserved-direct:' || $2::text)
       ON CONFLICT DO NOTHING`,
      [asset.id, projectId],
    );
    if (!preexistingPreservedAssetIds.has(asset.id)) {
      for (const key of assetKeys) newlyPreservedKeys.add(key);
    }
  }
  cleanupTargets.push(...cleanupByKey.values());
  return { imageIds, uploadIds, cleanupTargets, newlyPreservedKeys };
}

async function finalizeReconciledPreservedTargets(
  client: PoolClient,
  projectId: number,
  operationId: string,
  leaseVersion: number,
  targets: readonly FinalPurgeCleanupTarget[],
): Promise<void> {
  const keys = [...new Set(targets.map((target) => target.storageKey))];
  const assetIds = [...new Set(targets.map((target) => target.assetId))].sort((a, b) => a - b);
  if (keys.length !== targets.length || keys.length === 0) {
    throw new Error("project_purge_asset_release_failed");
  }
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [
      PROJECT_LIFECYCLE_LOCK_NAMESPACE,
      projectId,
    ]);
    const operation = await client.query<{
      state: string;
      lease_version: number;
      resource_progress: Record<string, unknown> | null;
    }>(
      `SELECT state, lease_version, resource_progress FROM project_purge_operations
        WHERE id=$1 AND project_id=$2 FOR UPDATE`,
      [operationId, projectId],
    );
    if (
      operation.rows[0]?.state !== "running" ||
      operation.rows[0].lease_version !== leaseVersion
    ) {
      throw new Error("project_purge_operation_conflict");
    }
    const project = await client.query("SELECT 1 FROM projects WHERE id=$1 FOR UPDATE", [
      projectId,
    ]);
    if (project.rowCount !== 1) throw new Error("project_purge_asset_release_failed");
    const assets = await client.query<{ id: number; state: string }>(
      `SELECT id, state FROM assets
        WHERE id=ANY($1::integer[]) AND project_id=$2
        ORDER BY id FOR UPDATE`,
      [assetIds, projectId],
    );
    if (
      assets.rowCount !== assetIds.length ||
      assets.rows.some((asset) => asset.state !== "deleting" && asset.state !== "deleted")
    ) {
      throw new Error("project_purge_asset_release_failed");
    }
    await lockLegacyMigrationKeys(client, keys);
    for (const target of targets) {
      const claim = await client.query<{
        claim_kind: string;
        retired_project_id: number | null;
        retired_asset_id: number | null;
      }>(
        `SELECT claim_kind, retired_project_id, retired_asset_id
           FROM durable_asset_deletion_claims WHERE storage_key=$1 FOR UPDATE`,
        [target.storageKey],
      );
      if (
        claim.rows[0]?.claim_kind !== "project-purge-preservation-reconcile" ||
        claim.rows[0]?.retired_project_id !== projectId ||
        claim.rows[0]?.retired_asset_id !== target.assetId
      ) {
        throw new Error("project_purge_asset_release_failed");
      }
      if (target.storageObjectId !== null) {
        const object = await client.query<{
          asset_id: number;
          storage_backend: string;
          storage_key: string;
          state: string;
        }>(
          `SELECT asset_id, storage_backend, storage_key, state
             FROM asset_storage_objects WHERE id=$1 FOR UPDATE`,
          [target.storageObjectId],
        );
        if (
          object.rows[0]?.asset_id !== target.assetId ||
          object.rows[0]?.storage_backend !== target.storageBackend ||
          object.rows[0]?.storage_key !== target.storageKey ||
          (object.rows[0]?.state !== "deleting" && object.rows[0]?.state !== "deleted")
        ) {
          throw new Error("project_purge_asset_release_failed");
        }
        await client.query(
          `UPDATE asset_storage_objects
              SET state='deleted', deleted_at=COALESCE(deleted_at, NOW())
            WHERE id=$1 AND asset_id=$2 AND state='deleting'`,
          [target.storageObjectId, target.assetId],
        );
      }
    }
    await client.query(
      `UPDATE assets asset_row
          SET state='deleted', deleted_at=COALESCE(deleted_at, NOW())
        WHERE asset_row.id=ANY($1::integer[])
          AND asset_row.project_id=$2
          AND asset_row.state='deleting'
          AND NOT EXISTS (
            SELECT 1 FROM asset_storage_objects storage_row
             WHERE storage_row.asset_id=asset_row.id AND storage_row.state <> 'deleted'
          )`,
      [assetIds, projectId],
    );
    const finalAssets = await client.query<{ id: number; state: string }>(
      `SELECT id, state FROM assets WHERE id=ANY($1::integer[]) ORDER BY id`,
      [assetIds],
    );
    if (
      finalAssets.rowCount !== assetIds.length ||
      finalAssets.rows.some((asset) => asset.state !== "deleted")
    ) {
      throw new Error("project_purge_asset_release_failed");
    }
    await client.query(
      `DELETE FROM asset_usage
        WHERE asset_id=ANY($1::integer[])
          AND project_id IS NULL
          AND consumer='project-purge-preserved-direct:' || $2::text`,
      [assetIds, projectId],
    );
    const cursor = readFinalFenceReconciliationCursor(operation.rows[0].resource_progress);
    for (const key of keys) {
      cursor.removedStorageKeys.add(key);
      if (!cursor.latePreservedStorageKeys.delete(key)) {
        cursor.removedProviderDetachedStorageKeys.add(key);
      }
    }
    const progress = {
      ...(operation.rows[0].resource_progress ?? {}),
      finalFenceReconciliation: writeFinalFenceReconciliationCursor(cursor),
    };
    const updated = await client.query(
      `UPDATE project_purge_operations SET resource_progress=$3::jsonb, updated_at=NOW()
        WHERE id=$1 AND project_id=$2 AND state='running' AND lease_version=$4`,
      [operationId, projectId, JSON.stringify(progress), leaseVersion],
    );
    if (updated.rowCount !== 1) throw new Error("project_purge_operation_conflict");
    await client.query(
      `DELETE FROM durable_asset_deletion_claims
        WHERE storage_key=ANY($1::text[])
          AND claim_kind='project-purge-preservation-reconcile'
          AND retired_project_id=$2`,
      [keys, projectId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function applyProjectRelationalPurge(
  projectId: number,
  operationId: string,
  input: {
    inventoryDigestSha256: string;
    providerRemoved: number;
    providerDetached: number;
    leaseVersion: number;
  },
): Promise<{
  absenceDigestSha256: string;
  removedResourceCount: number;
  detachedResourceCount: number;
}> {
  if (
    !/^[0-9a-f]{64}$/u.test(input.inventoryDigestSha256) ||
    !Number.isSafeInteger(input.providerRemoved) ||
    input.providerRemoved < 0 ||
    !Number.isSafeInteger(input.providerDetached) ||
    input.providerDetached < 0 ||
    !Number.isSafeInteger(input.leaseVersion) ||
    input.leaseVersion < 1
  ) {
    throw new Error("project_purge_relational_delete_failed");
  }
  const allocationIdentity = await productionDatabaseAllocationIdentity({
    format: "nabuflow.production-database-allocation/v1",
    deploymentNamespace: "production",
    projectId,
  });
  const catalog = await readProjectReferenceCatalog();
  const decision = validateProjectReferenceCatalog(catalog);
  if (!decision.ok) throw new Error("project_purge_inventory_unavailable");
  const client = await pool.connect();
  try {
    for (;;) {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [
        PROJECT_LIFECYCLE_LOCK_NAMESPACE,
        projectId,
      ]);
      const operation = await client.query<{
        state: string;
        lease_version: number;
        resource_progress: Record<string, unknown> | null;
      }>(
        `SELECT state, lease_version, resource_progress FROM project_purge_operations
        WHERE id=$1 AND project_id=$2 FOR UPDATE`,
        [operationId, projectId],
      );
      if (
        operation.rows[0]?.state !== "running" ||
        operation.rows[0].lease_version !== input.leaseVersion
      ) {
        throw new Error("project_purge_operation_conflict");
      }

      // Recheck under the final lifecycle/project locks even if an old resource
      // checkpoint says databaseComplete. Never cascade-delete an unknown POST.
      const project = await client.query<{
        deleted_at: Date | null;
        db_provider: string;
        db_status: string;
        neon_project_id: string | null;
        db_connection_id: string | null;
        preview_db_status: string;
        preview_db_has_url: boolean;
        preview_db_allocation: unknown;
      }>(
        `SELECT deleted_at, db_provider, db_status, neon_project_id, db_connection_id,
              preview_db_status, (preview_db_url IS NOT NULL) AS preview_db_has_url,
              preview_db_allocation
         FROM projects WHERE id=$1 FOR UPDATE`,
        [projectId],
      );
      const database = project.rows[0];
      if (
        !database?.deleted_at ||
        hasUnresolvedNeonAllocationIntent({
          dbProvider: database.db_provider,
          dbStatus: database.db_status,
          neonProjectId: database.neon_project_id,
          dbConnectionId: database.db_connection_id,
        })
      )
        throw new Error("project_purge_neon_allocation_unresolved");

      const preview: PreviewDatabaseState = {
        status: database.preview_db_status,
        hasCredential: database.preview_db_has_url,
        allocation: database.preview_db_allocation,
      };
      if (
        !previewDatabaseEvidenceMatches(
          projectId,
          preview,
          operation.rows[0]?.resource_progress?.previewDatabaseEvidence,
        )
      )
        throw new Error("project_purge_preview_allocation_unresolved");

      // Retention is conditional: the generic catalog exclusion cannot prove a seal.
      // A legacy seal closes admission but does not assert that no dispatch occurred.
      const sealedAdmission = await readSealedProductionDatabaseAdmission(
        client,
        projectId,
        allocationIdentity,
      );

      const protectedAliases = await fenceFinalPurgeAssets(client, projectId);
      const reconciliation = readFinalFenceReconciliationCursor(
        operation.rows[0].resource_progress,
      );
      for (const key of protectedAliases.newlyPreservedKeys) {
        if (!reconciliation.removedStorageKeys.has(key)) {
          reconciliation.latePreservedStorageKeys.add(key);
        }
      }
      if (protectedAliases.newlyPreservedKeys.size > 0) {
        const progress = {
          ...(operation.rows[0].resource_progress ?? {}),
          finalFenceReconciliation: writeFinalFenceReconciliationCursor(reconciliation),
        };
        const updated = await client.query(
          `UPDATE project_purge_operations SET resource_progress=$3::jsonb, updated_at=NOW()
          WHERE id=$1 AND project_id=$2 AND state='running' AND lease_version=$4`,
          [operationId, projectId, JSON.stringify(progress), input.leaseVersion],
        );
        if (updated.rowCount !== 1) throw new Error("project_purge_operation_conflict");
      }
      if (protectedAliases.cleanupTargets.length > 0) {
        await client.query("COMMIT");
        for (const target of protectedAliases.cleanupTargets) {
          await deleteStorageTargetAndProveAbsent({
            storageBackend: target.storageBackend,
            storageKey: target.storageKey,
          });
        }
        await finalizeReconciledPreservedTargets(
          client,
          projectId,
          operationId,
          input.leaseVersion,
          protectedAliases.cleanupTargets,
        );
        continue;
      }
      let removed = input.providerRemoved + reconciliation.removedStorageKeys.size;
      let detached =
        input.providerDetached -
        reconciliation.removedProviderDetachedStorageKeys.size +
        reconciliation.latePreservedStorageKeys.size;
      if (detached < 0) throw new Error("project_purge_relational_delete_failed");
      const execute = async (statement: string): Promise<number> => {
        const result = await client.query(statement, [projectId]);
        return result.rowCount ?? 0;
      };

      removed += await execute(`DELETE FROM support_zero_sessions WHERE project_id=$1`);
      removed += await execute(`DELETE FROM support_access_grants WHERE project_id=$1`);
      removed += await execute(`DELETE FROM support_tickets WHERE project_id=$1`);
      removed += await execute(`DELETE FROM agent_inbox WHERE project_id=$1`);
      removed += await execute(`DELETE FROM project_extensions WHERE project_id=$1`);
      removed += await execute(`DELETE FROM project_embeddings WHERE project_id=$1`);
      // Delete only metadata covered by the final fence, in this same transaction.
      for (const [table, protectedIds] of [
        ["generated_images", protectedAliases.imageIds],
        ["project_uploads", protectedAliases.uploadIds],
      ] as const) {
        const deleted = await client.query<{ id: number }>(
          `DELETE FROM ${table} WHERE project_id=$1 RETURNING id`,
          [projectId],
        );
        if (deleted.rows.some((row) => !protectedIds.has(row.id))) {
          throw new Error("project_purge_asset_release_failed");
        }
        removed += deleted.rowCount ?? 0;
      }
      removed += await execute(`DELETE FROM knowledge_entries WHERE project_id=$1`);
      removed += await execute(`DELETE FROM project_github_connections WHERE project_id=$1`);
      removed += await execute(
        `DELETE FROM notifications
        WHERE project_id=$1
          AND resource_type IS DISTINCT FROM 'project_purge'`,
      );
      detached += await execute(
        `UPDATE notifications
          SET project_id=NULL,
              actor_id=NULL,
              actor_name=NULL,
              title='Project deletion receipt',
              body='A project deletion milestone was recorded.'
        WHERE project_id=$1
          AND resource_type='project_purge'`,
      );
      detached += await execute(
        `UPDATE purchased_domains SET project_id=NULL, updated_at=NOW() WHERE project_id=$1`,
      );
      detached += await execute(
        `UPDATE credit_transactions SET project_id=NULL WHERE project_id=$1`,
      );
      detached += await execute(
        `UPDATE nabuflow_usage_events SET project_id=NULL WHERE project_id=$1`,
      );
      detached += await execute(
        `UPDATE gallery_templates SET source_project_id=NULL WHERE source_project_id=$1`,
      );

      const releasedQuota = await client.query<{
        owner_user_id: string;
        released_bytes: string;
      }>(
        `SELECT asset_row.owner_user_id,
              COALESCE(SUM(asset_row.size_bytes), 0)::text AS released_bytes
         FROM assets asset_row
        WHERE asset_row.project_id=$1
          AND NOT EXISTS (
            SELECT 1 FROM asset_usage other_usage
             WHERE other_usage.asset_id=asset_row.id
               AND other_usage.project_id IS DISTINCT FROM $1
               AND other_usage.consumer IS DISTINCT FROM
                   'project-purge-preserved-direct:' || $1::text
          )
        GROUP BY asset_row.owner_user_id`,
        [projectId],
      );
      for (const quota of releasedQuota.rows) {
        await client.query(
          `UPDATE account_asset_quota
            SET used_bytes=GREATEST(0, used_bytes-$2::bigint), updated_at=NOW()
          WHERE user_id=$1`,
          [quota.owner_user_id, quota.released_bytes],
        );
      }
      // Detach doomed pointers, never promote scope, infer product origin or mint a grant.
      // Surviving target-project explicit grants and ordinary usages remain unchanged.
      const rehomed = await client.query(
        `UPDATE assets asset_row
          SET project_id=NULL, thread_key=NULL,
              version_id=NULL, task_id=NULL, message_id=NULL
        WHERE asset_row.project_id=$1
          AND asset_row.state='ready'
          AND EXISTS (
            SELECT 1 FROM asset_usage other_usage
             WHERE other_usage.asset_id=asset_row.id
               AND other_usage.project_id IS DISTINCT FROM $1
          )`,
        [projectId],
      );
      detached += rehomed.rowCount ?? 0;
      await client.query(
        `DELETE FROM asset_usage
        WHERE project_id=$1
           OR consumer='project-purge-preserved-direct:' || $1::text`,
        [projectId],
      );

      const projectDelete = await client.query(`DELETE FROM projects WHERE id=$1`, [projectId]);
      if (projectDelete.rowCount !== 1) throw new Error("project_purge_relational_delete_failed");
      removed += 1;

      const remaining = await countProjectReferences(projectId, catalog, (statement, values) =>
        client.query(statement, values as unknown[]),
      );
      const nonzero = remaining.filter((entry) => entry.rowCount !== 0);
      if (nonzero.length > 0) throw new Error("project_purge_absence_unverified");
      const projectPresence = await client.query(`SELECT 1 FROM projects WHERE id=$1`, [projectId]);
      if (projectPresence.rowCount !== 0) throw new Error("project_purge_absence_unverified");
      const retainedProductionDatabaseAdmission = await readSealedProductionDatabaseAdmission(
        client,
        projectId,
        allocationIdentity,
      );
      if (digest(retainedProductionDatabaseAdmission) !== digest(sealedAdmission)) {
        throw new Error("project_purge_absence_unverified");
      }
      // Commit the typed retained proof through the existing terminal digest field.
      const absenceDigestSha256 = digest({
        projectId,
        remaining,
        projectPresent: false,
        retainedProductionDatabaseAdmission,
      });
      const terminalEvidence = {
        schema: "project-purge-terminal-v1",
        outcome: "completed",
        inventoryDigestSha256: input.inventoryDigestSha256,
        absenceDigestSha256,
        removedResourceCount: removed,
        detachedResourceCount: detached,
      };
      const terminal = await client.query(
        `UPDATE project_purge_operations
          SET state='completed', stage='absence', failure_code=NULL,
              failure_retryable=NULL, terminal_evidence=$3::jsonb,
              lease_expires_at=NULL, terminal_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND project_id=$2 AND state='running' AND lease_version=$4`,
        [operationId, projectId, JSON.stringify(terminalEvidence), input.leaseVersion],
      );
      if (terminal.rowCount !== 1) throw new Error("project_purge_operation_conflict");
      await client.query("COMMIT");
      return {
        absenceDigestSha256,
        removedResourceCount: removed,
        detachedResourceCount: detached,
      };
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
