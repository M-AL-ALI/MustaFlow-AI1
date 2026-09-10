import { createHash, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import {
  beginAssetUpload,
  completeAsset,
  rejectReservedAsset,
  reserveAsset,
} from "./asset-registry";
import { deleteAssetObject, headAssetObject, putAssetBuffer } from "./asset-r2";
import { registerProjectWorkController, withActiveProjectLifecycle } from "./project-lifecycle";
import { bindPreviewVersion, readPreviewVersionWitness } from "./preview-version-provenance";
import { tenantRuntimeProvider } from "./tenant-runtime";
import { supportsProjectPreviewCapture } from "./tenant-runtime-provider";
import { automaticPreviewAdmitted } from "./automatic-preview-admission";
import {
  AUTOMATIC_PREVIEW_MAX_BYTES,
  AUTOMATIC_PREVIEW_SCHEMA,
  AUTOMATIC_PREVIEW_SOURCE,
  AUTOMATIC_PREVIEW_VIEWPORT,
  AutomaticPreviewError,
  createAutomaticPreviewRunner,
  type AutomaticPreviewAttempt,
  type AutomaticPreviewDependencies,
  type AutomaticPreviewProject,
  type AutomaticPreviewReservation,
  type AutomaticPreviewTarget,
} from "./automatic-preview-capture";

export async function readAutomaticPreviewAttempts(
  target: AutomaticPreviewTarget,
  ownerId: string,
  key: string,
): Promise<AutomaticPreviewAttempt[]> {
  const result = await pool.query<{
    id: number;
    storage_key: string;
    state: string;
    created_at: Date;
    needs_cleanup: boolean;
  }>(
    `SELECT a.id, a.storage_key, a.state, a.created_at,
       EXISTS (SELECT 1 FROM asset_storage_objects o
                WHERE o.asset_id=a.id AND o.state='deleting') AS needs_cleanup
       FROM assets a
      WHERE a.product_scope='nabuflow' AND a.scope='project' AND a.kind='snapshot'
        AND a.source=$1 AND a.project_id=$2 AND a.version_id=$3
        AND a.owner_user_id=$4 AND a.actor_user_id=$4
        AND a.context->'automaticPreview'->>'key'=$5
      ORDER BY a.id`,
    [AUTOMATIC_PREVIEW_SOURCE, target.projectId, target.versionId, ownerId, key],
  );
  return result.rows.map((row) => ({
    id: row.id,
    storageKey: row.storage_key,
    state: row.state,
    createdAt: new Date(row.created_at),
    needsCleanup: row.needs_cleanup,
  }));
}

/**
 * putState is a durable, one-way write gate:
 * not-started -> pending -> acknowledged; cleanup closes not-started/acknowledged.
 * A pending or missing marker is NOT terminal proof, regardless of age or HEAD.
 * Such rows retain their reservation and quota until authoritative proof exists.
 */
export async function cleanupAutomaticPreview(
  asset: AutomaticPreviewReservation,
  project: AutomaticPreviewProject,
): Promise<void> {
  const params = [
    asset.id,
    project.id,
    project.ownerId,
    asset.storageKey,
    AUTOMATIC_PREVIEW_SOURCE,
  ];
  // Serialize against both the PUT admission update and completeAsset. Closing
  // this gate prevents a stale owner from sending bytes after cleanup starts.
  const closed = await pool.query<{ id: number }>(
    `UPDATE assets SET context=jsonb_set(
        context, '{automaticPreview,putState}', '"closed"'::jsonb)
      WHERE id=$1 AND project_id=$2
        AND owner_user_id=$3 AND actor_user_id=$3 AND storage_key=$4
        AND product_scope='nabuflow' AND scope='project' AND kind='snapshot' AND source=$5
        AND state IN ('reserved', 'uploading', 'rejected')
        AND context->'automaticPreview'->>'putState'
          IN ('not-started', 'acknowledged', 'closed')
      RETURNING id`,
    params,
  );
  if (closed.rows.length === 0) {
    const owned = await pool.query<{ state: string; put_state: string | null }>(
      `SELECT state, context->'automaticPreview'->>'putState' AS put_state
         FROM assets WHERE id=$1 AND project_id=$2
          AND owner_user_id=$3 AND actor_user_id=$3 AND storage_key=$4
          AND product_scope='nabuflow' AND scope='project' AND kind='snapshot' AND source=$5`,
      params,
    );
    const row = owned.rows[0];
    // Includes governed deletion and a final COMMIT that won the row lock.
    if (!row || !["reserved", "uploading", "rejected"].includes(row.state)) return;
    // Do not reject, release quota, DELETE, HEAD or record absence here. A
    // successful HEAD cannot prove that an earlier remote PUT will not arrive.
    throw new AutomaticPreviewError("automatic_preview_put_uncertain");
  }

  await rejectReservedAsset({
    assetId: asset.id,
    ownerUserId: project.ownerId,
    actorUserId: project.ownerId,
    code: "asset_storage_unavailable",
  });
  const rejected = await pool.query<{ storage_key: string }>(
    `SELECT o.storage_key FROM assets a JOIN asset_storage_objects o ON o.asset_id=a.id
      WHERE a.id=$1 AND a.project_id=$2 AND a.owner_user_id=$3 AND a.actor_user_id=$3
        AND a.product_scope='nabuflow' AND a.scope='project' AND a.kind='snapshot'
        AND a.source=$5 AND a.state='rejected'
        AND a.context->'automaticPreview'->>'putState'='closed'
        AND a.storage_key=$4 AND o.storage_key=$4 AND o.storage_backend='r2'
        AND o.role='primary' AND o.state='deleting'`,
    params,
  );
  if (rejected.rows.length === 0) return; // Includes an ambiguous successful COMMIT.
  await deleteAssetObject(asset.storageKey);
  if ((await headAssetObject(asset.storageKey)) !== null) {
    throw new AutomaticPreviewError("automatic_preview_object_still_present");
  }
  await pool.query(
    `UPDATE asset_storage_objects o SET state='deleted', deleted_at=NOW()
       FROM assets a WHERE o.asset_id=a.id AND a.id=$1 AND a.project_id=$2
        AND a.owner_user_id=$3 AND a.actor_user_id=$3 AND a.product_scope='nabuflow'
        AND a.scope='project' AND a.kind='snapshot' AND a.source=$5 AND a.state='rejected'
        AND a.context->'automaticPreview'->>'putState'='closed' AND a.storage_key=$4
        AND o.storage_key=$4 AND o.role='primary' AND o.storage_backend='r2' AND o.state='deleting'`,
    params,
  );
}

export const automaticPreviewDependencies: AutomaticPreviewDependencies = {
  withProject: withActiveProjectLifecycle,
  async loadProject(target) {
    const result = await pool.query<{ id: number; owner_id: string }>(
      `SELECT p.id, p.owner_id FROM projects p
        JOIN project_versions v ON v.project_id=p.id AND v.id=$2
       WHERE p.id=$1 AND p.deleted_at IS NULL`,
      [target.projectId, target.versionId],
    );
    const row = result.rows[0];
    return row ? { id: row.id, ownerId: row.owner_id } : null;
  },
  admit: automaticPreviewAdmitted,
  readWitness: readPreviewVersionWitness,
  readAttempts: readAutomaticPreviewAttempts,
  reserve(project, witness, key) {
    return reserveAsset({
      productScope: "nabuflow",
      ownerUserId: project.ownerId,
      actorUserId: project.ownerId,
      projectId: project.id,
      threadKey: null,
      scope: "project",
      kind: "snapshot",
      source: AUTOMATIC_PREVIEW_SOURCE,
      filename: `project-preview-v${witness.versionId}.png`,
      mimeType: "image/png",
      sizeBytes: AUTOMATIC_PREVIEW_MAX_BYTES,
      versionId: witness.versionId,
      context: {
        route: "/",
        viewport: AUTOMATIC_PREVIEW_VIEWPORT,
        previewSource: "server",
        versionProvenance: bindPreviewVersion(project.id, witness, witness),
        automaticPreview: {
          schema: AUTOMATIC_PREVIEW_SCHEMA,
          key,
          putState: "not-started",
        },
      },
    });
  },
  async begin(asset, project) {
    return Boolean(
      await beginAssetUpload({
        assetId: asset.id,
        actorUserId: project.ownerId,
      }),
    );
  },
  async capture(witness, signal) {
    if (!supportsProjectPreviewCapture(tenantRuntimeProvider)) {
      throw new AutomaticPreviewError("automatic_preview_provider_unavailable");
    }
    return tenantRuntimeProvider.captureProjectPreview(
      {
        projectId: witness.projectId,
        runtimeIdentity: witness.runtimeIdentity,
        manifestRevision: witness.manifestRevision,
        sealedArtifactSha256: witness.sealedArtifactSha256,
        route: "/",
        viewport: AUTOMATIC_PREVIEW_VIEWPORT,
      },
      { idempotencyKey: randomUUID(), timeoutMs: 45_000, signal },
    );
  },
  async upload(asset, bytes, signal) {
    if (signal.aborted) {
      throw new AutomaticPreviewError("automatic_preview_project_inactive");
    }
    const params = [asset.id, asset.storageKey, AUTOMATIC_PREVIEW_SOURCE];
    // Persist uncertainty BEFORE dispatch. A lost SQL response cannot cause a
    // PUT: this call must positively acquire the one-use write gate first.
    const pending = await pool.query<{ id: number }>(
      `UPDATE assets SET context=jsonb_set(
          context, '{automaticPreview,putState}', '"pending"'::jsonb)
        WHERE id=$1 AND storage_key=$2 AND source=$3 AND state='uploading'
          AND product_scope='nabuflow' AND scope='project' AND kind='snapshot'
          AND context->'automaticPreview'->>'putState'='not-started'
        RETURNING id`,
      params,
    );
    if (pending.rows.length !== 1) {
      throw new AutomaticPreviewError("automatic_preview_reservation_unavailable");
    }
    // A timeout/abort/failure leaves pending intact. No elapsed-time heuristic,
    // HEAD or DELETE can establish terminal failure for this remote request.
    await putAssetBuffer({
      key: asset.storageKey,
      body: bytes,
      contentType: "image/png",
      abortSignal: signal,
    });
    // Only a successful PUT acknowledgment supplies terminal write proof. If
    // persisting that proof fails, retain uncertainty rather than infer absence.
    const acknowledged = await pool.query<{ id: number }>(
      `UPDATE assets SET context=jsonb_set(
          context, '{automaticPreview,putState}', '"acknowledged"'::jsonb)
        WHERE id=$1 AND storage_key=$2 AND source=$3 AND state='uploading'
          AND product_scope='nabuflow' AND scope='project' AND kind='snapshot'
          AND context->'automaticPreview'->>'putState'='pending'
        RETURNING id`,
      params,
    );
    if (acknowledged.rows.length !== 1) {
      throw new AutomaticPreviewError("automatic_preview_put_uncertain");
    }
    const stored = await headAssetObject(asset.storageKey);
    if (stored?.sizeBytes !== bytes.length) {
      throw new AutomaticPreviewError("automatic_preview_storage_size_mismatch");
    }
  },
  complete(asset, project, bytes) {
    return completeAsset({
      assetId: asset.id,
      ownerUserId: project.ownerId,
      actorUserId: project.ownerId,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      scanState: "not-required",
      finalSizeBytes: bytes.length,
      finalMimeType: "image/png",
    });
  },
  cleanup: cleanupAutomaticPreview,
  track: registerProjectWorkController,
};

export const runAutomaticProjectPreview = createAutomaticPreviewRunner(
  automaticPreviewDependencies,
);
