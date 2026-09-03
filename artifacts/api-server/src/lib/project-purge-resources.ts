import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { pool } from "@workspace/db";
import type { PoolClient } from "pg";
import { deleteAssetObject, headAssetObject } from "./asset-r2";
import { ObjectNotFoundError, ObjectStorageService } from "./objectStorage";
import {
  hasCurrentProjectRetirementCompletionEvidence,
  PROJECT_LIFECYCLE_LOCK_NAMESPACE,
} from "./project-retirement-contract";
import { deleteSnapshotBlob, snapshotBlobExists } from "./snapshot-storage";

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
      WHERE image.asset_id=$1
     UNION
     SELECT '/api/projects/' || upload.project_id::text || '/uploads/' || upload.id::text || '/content'
       FROM project_uploads upload
       JOIN assets asset
         ON asset.id=$1
        AND asset.storage_key=upload.object_path`,
    [assetId],
  );
  const canonical = `/api/assets/${assetId}/content`;
  for (const row of aliases.rows) {
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
      `UPDATE canvas_variant_library SET files=replace(files::text, $2, $3)::jsonb
        WHERE position($2 in coalesce(files::text, '')) > 0`,
      values,
    );
    await client.query(
      `UPDATE gallery_templates
          SET files_snapshot=replace(files_snapshot::text, $2, $3)::jsonb
        WHERE position($2 in coalesce(files_snapshot::text, '')) > 0`,
      values,
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
        WHERE ($1::integer IS NULL OR EXISTS (
          SELECT 1 FROM agent_tasks task
           WHERE task.id=event_row.task_id AND task.project_id IS DISTINCT FROM $1
        )) AND (position($2 in coalesce(event_row.message, '')) > 0
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
          AND (position($2 in coalesce(file_url, '')) > 0
            OR position($2 in coalesce(thumbnail_url, '')) > 0)`,
      values,
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
    retirement_operation_id: string | null;
    retirement_state: string | null;
    retirement_completed_at: Date | null;
    retirement_progress: unknown;
  }>(
    `SELECT project_row.id, project_row.owner_id, project_row.name,
            project_row.deleted_at, project_row.neon_project_id,
            project_row.db_connection_id,
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

  const assetResult = await pool.query<{
    asset_id: number;
    owner_user_id: string;
    storage_backend: string | null;
    storage_key: string | null;
    size_bytes: string | number | null;
    shared: boolean;
  }>(
    `SELECT asset_row.id AS asset_id,
            asset_row.owner_user_id,
            storage_row.storage_backend,
            storage_row.storage_key,
            storage_row.size_bytes,
            EXISTS (
              SELECT 1 FROM asset_usage usage_row
               WHERE usage_row.asset_id=asset_row.id
                 AND usage_row.project_id IS DISTINCT FROM $1
                 AND usage_row.consumer IS DISTINCT FROM
                     'project-purge-preserved-direct:' || $1::text
            ) AS shared
       FROM assets asset_row
       LEFT JOIN asset_storage_objects storage_row
         ON storage_row.asset_id=asset_row.id AND storage_row.state <> 'deleted'
      WHERE asset_row.project_id=$1
      ORDER BY asset_row.id, storage_row.id`,
    [projectId],
  );
  const assetTargets = assetResult.rows
    .filter((row): row is typeof row & { storage_backend: string; storage_key: string } =>
      Boolean(row.storage_backend && row.storage_key),
    )
    .map((row) => ({
      assetId: row.asset_id,
      ownerUserId: row.owner_user_id,
      shared: row.shared,
      storageBackend: row.storage_backend,
      storageKey: row.storage_key,
      sizeBytes: Number(row.size_bytes ?? 0),
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
  const neonProjectIds = [...new Set([project.neon_project_id, project.db_connection_id])]
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
      backend: target.storageBackend,
      storageKey: target.storageKey,
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
  return {
    projectId,
    ownerId: project.owner_id,
    projectName: project.name,
    deletedAt: project.deleted_at,
    retirementOperationId: project.retirement_operation_id,
    retirementProgress: project.retirement_progress,
    neonProjectIds,
    productionNeonProjectName: `mf-project-${projectId}`,
    previewNeonProjectName: `mf-preview-${projectId}`,
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
}

async function deleteLegacyObjectAndProveAbsent(
  objectPath: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const storage = new ObjectStorageService();
  try {
    const file = await storage.getObjectEntityFile(objectPath);
    await file.delete({ ignoreNotFound: true });
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
    const locked = await client.query<{ state: string }>(
      `SELECT state FROM assets
        WHERE id=$2 AND project_id=$1
        FOR UPDATE`,
      [projectId, target.assetId],
    );
    const state = locked.rows[0]?.state;
    if (!state || !["reserved", "uploading", "ready", "deleting", "rejected"].includes(state)) {
      throw new Error("project_purge_asset_release_failed");
    }
    const storageObjects = await client.query<{ storage_key: string }>(
      `SELECT storage_key
         FROM asset_storage_objects
        WHERE asset_id=$1 AND state <> 'deleted'
        ORDER BY storage_key
        FOR UPDATE`,
      [target.assetId],
    );
    const storageKeys = Array.from(
      new Set([...storageObjects.rows.map((row) => row.storage_key), target.storageKey]),
    ).sort();
    for (const storageKey of storageKeys) {
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('nabuflow:durable-object:' || $1, 0)
         )`,
        [storageKey],
      );
    }
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
      // older caller did not write asset_usage. Preserve an account-scoped
      // ledger row so relational deletion rehomes the asset metadata together
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
        WHERE asset_id=$2 AND storage_key=$3 AND state <> 'deleted'`,
      [projectId, target.assetId, target.storageKey],
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
    [projectId, storageKey],
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
  const catalog = await readProjectReferenceCatalog();
  const decision = validateProjectReferenceCatalog(catalog);
  if (!decision.ok) throw new Error("project_purge_inventory_unavailable");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [
      PROJECT_LIFECYCLE_LOCK_NAMESPACE,
      projectId,
    ]);
    const operation = await client.query<{ state: string; lease_version: number }>(
      `SELECT state, lease_version FROM project_purge_operations
        WHERE id=$1 AND project_id=$2 FOR UPDATE`,
      [operationId, projectId],
    );
    if (
      operation.rows[0]?.state !== "running" ||
      operation.rows[0].lease_version !== input.leaseVersion
    ) {
      throw new Error("project_purge_operation_conflict");
    }

    let removed = input.providerRemoved;
    let detached = input.providerDetached;
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
    removed += await execute(`DELETE FROM generated_images WHERE project_id=$1`);
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
    detached += await execute(`UPDATE credit_transactions SET project_id=NULL WHERE project_id=$1`);
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
    const rehomed = await client.query(
      `UPDATE assets asset_row
          SET project_id=NULL, scope='account', thread_key=NULL,
              version_id=NULL, task_id=NULL, message_id=NULL
        WHERE asset_row.project_id=$1
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
    const absenceDigestSha256 = digest({ projectId, remaining, projectPresent: false });
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
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
