import { pool } from "@workspace/db";
import { headAssetObject } from "./asset-r2";
import { ObjectNotFoundError, ObjectStorageService } from "./objectStorage";

export const ASSET_STORAGE_RECONCILIATION_LIMIT = 50;
const ASSET_STORAGE_RECONCILIATION_LOCK_NAMESPACE = 864_209;
const RECONCILIATION_STALE_AFTER_MINUTES = 15;

export type AssetStorageReconciliationReceipt = {
  inspected: number;
  measured: number;
  measuredBytes: number;
  absentThumbnails: number;
  remainingUnmeasured: number;
  admissionUnlocked: boolean;
  terminals: Array<{
    assetId: number;
    objectId: number;
    role: string;
    outcome: "primary-missing";
  }>;
};

export type AssetStorageReconciliationTerminal = {
  code: "asset_storage_reconciliation_failed";
  retryable: true;
  errorClass: "provider" | "database" | "unknown";
};

export class AssetStorageReconciliationError extends Error {
  readonly code = "asset_storage_reconciliation_failed";
  readonly retryable = true;

  constructor(readonly terminal: AssetStorageReconciliationTerminal) {
    super("Storage metadata reconciliation did not complete. It is safe to retry.");
    this.name = "AssetStorageReconciliationError";
  }
}

async function headTrackedStorageObject(
  key: string,
  storageBackend: string,
): Promise<{ sizeBytes: number } | null> {
  if (storageBackend === "r2") return headAssetObject(key);
  if (storageBackend === "legacy-object") {
    const storage = new ObjectStorageService();
    try {
      const file = await storage.getObjectEntityFile(key);
      const [metadata] = await file.getMetadata();
      const sizeBytes = Number(metadata.size);
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw new Error("asset_storage_metadata_invalid");
      }
      return { sizeBytes };
    } catch (error) {
      if (error instanceof ObjectNotFoundError) return null;
      throw error;
    }
  }
  throw new Error("asset_storage_backend_unavailable");
}

/**
 * Governed, bounded adoption of provider metadata for historical objects whose
 * byte size was never recorded.  It reads HEAD only and applies each resulting
 * quota delta in the same transaction as the physical-object receipt.
 */
export async function reconcileUnmeasuredR2AssetObjects(input?: {
  limit?: number;
  headObject?: (key: string, storageBackend: string) => Promise<{ sizeBytes: number } | null>;
}): Promise<AssetStorageReconciliationReceipt> {
  const limit = Math.min(
    ASSET_STORAGE_RECONCILIATION_LIMIT,
    Math.max(1, Math.trunc(input?.limit ?? ASSET_STORAGE_RECONCILIATION_LIMIT)),
  );
  const headObject = input?.headObject ?? headTrackedStorageObject;
  const candidates = await pool.query<{
    object_id: number;
    asset_id: number;
    storage_key: string;
    storage_backend: string;
    role: string;
  }>(
    `SELECT object.id AS object_id, object.asset_id, object.storage_key,
            object.storage_backend, object.role
       FROM asset_storage_objects object
       JOIN assets asset ON asset.id=object.asset_id
      WHERE object.storage_backend IN ('r2', 'legacy-object')
        AND object.state='ready'
        AND object.size_measured_at IS NULL
        AND asset.state='ready'
      ORDER BY object.id
      LIMIT $1`,
    [limit],
  );

  const receipt: AssetStorageReconciliationReceipt = {
    inspected: candidates.rows.length,
    measured: 0,
    measuredBytes: 0,
    absentThumbnails: 0,
    remainingUnmeasured: 0,
    admissionUnlocked: false,
    terminals: [],
  };

  for (const candidate of candidates.rows) {
    const provider = await headObject(candidate.storage_key, candidate.storage_backend);
    if (!provider) {
      if (candidate.role !== "thumbnail") {
        receipt.terminals.push({
          assetId: candidate.asset_id,
          objectId: candidate.object_id,
          role: candidate.role,
          outcome: "primary-missing",
        });
        continue;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const changed = await client.query(
          `UPDATE asset_storage_objects
              SET state='deleted', deleted_at=NOW()
            WHERE id=$1 AND asset_id=$2 AND role='thumbnail'
              AND state='ready' AND size_measured_at IS NULL`,
          [candidate.object_id, candidate.asset_id],
        );
        if (changed.rowCount) {
          await client.query(
            `UPDATE generated_images SET thumbnail_url=NULL, updated_at=NOW()
              WHERE asset_id=$1`,
            [candidate.asset_id],
          );
          receipt.absentThumbnails += 1;
        }
        await client.query("COMMIT");
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original error.
        }
        throw error;
      } finally {
        client.release();
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const asset = await client.query<{
        owner_user_id: string;
        size_bytes: string;
      }>(
        `SELECT owner_user_id, size_bytes FROM assets
          WHERE id=$1 AND state='ready' FOR UPDATE`,
        [candidate.asset_id],
      );
      if (!asset.rowCount) {
        await client.query("ROLLBACK");
        continue;
      }
      const measured = await client.query(
        `UPDATE asset_storage_objects SET size_bytes=$3, size_measured_at=NOW()
          WHERE id=$1 AND asset_id=$2 AND state='ready' AND size_measured_at IS NULL`,
        [candidate.object_id, candidate.asset_id, provider.sizeBytes],
      );
      if (!measured.rowCount) {
        await client.query("ROLLBACK");
        continue;
      }
      const total = await client.query<{ total_bytes: string }>(
        `SELECT COALESCE(SUM(size_bytes), 0)::text AS total_bytes
           FROM asset_storage_objects
          WHERE asset_id=$1 AND state='ready'`,
        [candidate.asset_id],
      );
      const previousBytes = Number(asset.rows[0]!.size_bytes);
      const nextBytes = Number(total.rows[0]?.total_bytes ?? previousBytes);
      const delta = nextBytes - previousBytes;
      await client.query(`UPDATE assets SET size_bytes=$2 WHERE id=$1`, [
        candidate.asset_id,
        nextBytes,
      ]);
      const quota = await client.query(
        `UPDATE account_asset_quota
            SET used_bytes=GREATEST(0, used_bytes+$2), updated_at=NOW()
          WHERE user_id=$1`,
        [asset.rows[0]!.owner_user_id, delta],
      );
      if (!quota.rowCount) throw new Error("asset_quota_receipt_missing");
      await client.query("COMMIT");
      receipt.measured += 1;
      receipt.measuredBytes += provider.sizeBytes;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  const remaining = await pool.query<{ remaining: string }>(
    `SELECT COUNT(*)::text AS remaining
       FROM asset_storage_objects object
       JOIN assets asset ON asset.id=object.asset_id
      WHERE object.storage_backend IN ('r2', 'legacy-object')
        AND object.state='ready'
        AND object.size_measured_at IS NULL
        AND asset.state='ready'`,
  );
  receipt.remainingUnmeasured = Number(remaining.rows[0]?.remaining ?? 0);
  receipt.admissionUnlocked = receipt.remainingUnmeasured === 0;

  return receipt;
}

function errorClass(error: unknown): AssetStorageReconciliationTerminal["errorClass"] {
  const value = error as { name?: unknown; code?: unknown };
  if (value?.name === "AssetStorageReconciliationError") return "database";
  if (typeof value?.code === "string" && value.code.startsWith("asset_")) return "database";
  if (error instanceof Error && /r2|provider|storage/iu.test(error.message)) return "provider";
  return "unknown";
}

/**
 * Give the governed mutation a durable request identity and serialize provider
 * observation globally. A repeated completed identity replays its exact receipt;
 * a crashed running identity becomes reclaimable only after the typed lease.
 */
export async function runDurableAssetStorageReconciliation(input: {
  requestId: string;
  limit: number;
  headObject?: (key: string, storageBackend: string) => Promise<{ sizeBytes: number } | null>;
}): Promise<AssetStorageReconciliationReceipt> {
  const client = await pool.connect();
  let lockHeld = false;
  try {
    const inserted = await client.query(
      `INSERT INTO asset_storage_reconciliation_runs (request_id, state)
       VALUES ($1, 'running')
       ON CONFLICT (request_id) DO NOTHING
       RETURNING request_id`,
      [input.requestId],
    );
    if (!inserted.rowCount) {
      const existing = await client.query<{
        state: string;
        receipt: AssetStorageReconciliationReceipt | null;
        terminal: AssetStorageReconciliationTerminal | null;
      }>(
        `SELECT state, receipt, terminal
           FROM asset_storage_reconciliation_runs
          WHERE request_id=$1`,
        [input.requestId],
      );
      const row = existing.rows[0];
      if (row?.state === "completed" && row.receipt) return row.receipt;
      if (row?.state === "failed" && row.terminal) {
        throw new AssetStorageReconciliationError(row.terminal);
      }
      const reclaimed = await client.query(
        `UPDATE asset_storage_reconciliation_runs
            SET updated_at=NOW()
          WHERE request_id=$1 AND state='running'
            AND updated_at < NOW() - ($2::integer * INTERVAL '1 minute')
        RETURNING request_id`,
        [input.requestId, RECONCILIATION_STALE_AFTER_MINUTES],
      );
      if (!reclaimed.rowCount) {
        throw new AssetStorageReconciliationError({
          code: "asset_storage_reconciliation_failed",
          retryable: true,
          errorClass: "database",
        });
      }
    }

    const lock = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock($1, 1) AS acquired`,
      [ASSET_STORAGE_RECONCILIATION_LOCK_NAMESPACE],
    );
    lockHeld = lock.rows[0]?.acquired === true;
    if (!lockHeld) {
      const terminal: AssetStorageReconciliationTerminal = {
        code: "asset_storage_reconciliation_failed",
        retryable: true,
        errorClass: "database",
      };
      await client.query(
        `UPDATE asset_storage_reconciliation_runs
            SET state='failed', terminal=$2::jsonb, updated_at=NOW(), completed_at=NOW()
          WHERE request_id=$1 AND state='running'`,
        [input.requestId, JSON.stringify(terminal)],
      );
      throw new AssetStorageReconciliationError(terminal);
    }

    try {
      const receipt = await reconcileUnmeasuredR2AssetObjects({
        limit: input.limit,
        headObject: input.headObject,
      });
      await client.query(
        `UPDATE asset_storage_reconciliation_runs
            SET state='completed', receipt=$2::jsonb, terminal=NULL,
                updated_at=NOW(), completed_at=NOW()
          WHERE request_id=$1 AND state='running'`,
        [input.requestId, JSON.stringify(receipt)],
      );
      return receipt;
    } catch (error) {
      const terminal: AssetStorageReconciliationTerminal = {
        code: "asset_storage_reconciliation_failed",
        retryable: true,
        errorClass: errorClass(error),
      };
      await client.query(
        `UPDATE asset_storage_reconciliation_runs
            SET state='failed', terminal=$2::jsonb, updated_at=NOW(), completed_at=NOW()
          WHERE request_id=$1 AND state='running'`,
        [input.requestId, JSON.stringify(terminal)],
      );
      throw new AssetStorageReconciliationError(terminal);
    }
  } finally {
    if (lockHeld) {
      await client
        .query(`SELECT pg_advisory_unlock($1, 1)`, [ASSET_STORAGE_RECONCILIATION_LOCK_NAMESPACE])
        .catch(() => undefined);
    }
    client.release();
  }
}
