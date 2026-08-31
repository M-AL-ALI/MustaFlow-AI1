import { pool } from "@workspace/db";
import { assetR2Configured } from "./asset-r2";
import {
  deleteTrackedAssetStorageObjects,
  type TrackedAssetStorageObject,
} from "./asset-storage-cleanup";
import { logger } from "./logger";

export const ASSET_RESERVATION_TTL_MS = 60 * 60 * 1_000;
export const ASSET_UPLOAD_TTL_MS = 2 * 60 * 60 * 1_000;
export const ASSET_RESERVATION_SWEEP_LIMIT = 50;
export const ASSET_RESERVATION_SWEEP_INTERVAL_MS = 5 * 60 * 1_000;

type ExpiredReservationClaim = {
  id: number;
  owner_user_id: string;
  size_bytes: string;
  quota_bucket: "reserved" | "used" | "none";
};

export type AssetReservationSweepReceipt = {
  claimed: number;
  expired: number;
  pendingProviderCleanup: number;
};

/**
 * Bounded durable cleanup for reservations abandoned before their bytes became
 * usable.  Claiming happens before provider deletion; a provider failure leaves
 * the `deleting` row for the next bounded pass.  Completion and expiry both
 * serialize on the asset row, so exactly one side owns the quota transition.
 */
export async function sweepExpiredAssetReservations(input?: {
  limit?: number;
  deleteStorageObjects?: (objects: readonly TrackedAssetStorageObject[]) => Promise<void>;
}): Promise<AssetReservationSweepReceipt> {
  const limit = Math.min(
    ASSET_RESERVATION_SWEEP_LIMIT,
    Math.max(1, Math.trunc(input?.limit ?? ASSET_RESERVATION_SWEEP_LIMIT)),
  );
  const deleteStorageObjects = input?.deleteStorageObjects ?? deleteTrackedAssetStorageObjects;
  const claimed = await pool.query<ExpiredReservationClaim>(
    `WITH candidates AS (
       SELECT id,
              CASE
                WHEN state='rejected' THEN 'none'
                WHEN ready_at IS NOT NULL THEN 'used'
                ELSE 'reserved'
              END AS quota_bucket
         FROM assets
        WHERE (
                state='reserved'
                AND created_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
              )
           OR (
                state='uploading'
                AND upload_started_at < NOW() - ($2::bigint * INTERVAL '1 millisecond')
              )
           OR (
                state='deleting'
                AND (
                  ready_at IS NOT NULL
                  OR rejection_code='asset_reservation_expired'
                )
              )
           OR (
                state='rejected'
                AND EXISTS (
                  SELECT 1 FROM asset_storage_objects object
                   WHERE object.asset_id=assets.id AND object.state='deleting'
                )
              )
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT $3
     )
     , claimed AS (
       UPDATE assets asset
          SET state=CASE WHEN asset.state='rejected' THEN 'rejected' ELSE 'deleting' END,
              rejection_code=CASE
                WHEN asset.state='rejected' OR asset.ready_at IS NOT NULL
                  THEN asset.rejection_code
                ELSE 'asset_reservation_expired'
              END
         FROM candidates
        WHERE asset.id=candidates.id
       RETURNING asset.id, asset.owner_user_id, asset.size_bytes, candidates.quota_bucket
     )
     , marked_objects AS (
       UPDATE asset_storage_objects object
          SET state='deleting'
         FROM claimed
        WHERE object.asset_id=claimed.id
          AND object.state IN ('reserved', 'uploading', 'ready')
       RETURNING object.id
     )
     SELECT id, owner_user_id, size_bytes, quota_bucket FROM claimed`,
    [ASSET_RESERVATION_TTL_MS, ASSET_UPLOAD_TTL_MS, limit],
  );

  let expired = 0;
  let pendingProviderCleanup = 0;
  for (const asset of claimed.rows) {
    const storageObjects = await pool.query<{
      storage_key: string;
      storage_backend: string;
    }>(
      `SELECT storage_key, storage_backend FROM asset_storage_objects
        WHERE asset_id=$1 AND state='deleting'
        ORDER BY id`,
      [asset.id],
    );
    try {
      await deleteStorageObjects(
        storageObjects.rows.map((object) => ({
          storageKey: object.storage_key,
          storageBackend: object.storage_backend,
        })),
      );
    } catch (error) {
      pendingProviderCleanup += 1;
      logger.warn(
        { assetId: asset.id, errorClass: error instanceof Error ? error.name : "unknown" },
        "expired asset reservation provider cleanup remains pending",
      );
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE asset_storage_objects
            SET state='deleted', deleted_at=NOW()
          WHERE asset_id=$1 AND state='deleting'`,
        [asset.id],
      );
      const finalized = await client.query<{
        owner_user_id: string;
        size_bytes: string;
        ready_at: Date | null;
      }>(
        `UPDATE assets
            SET state=CASE WHEN ready_at IS NULL THEN 'rejected' ELSE 'deleted' END,
                deleted_at=NOW()
          WHERE id=$1 AND state='deleting'
            AND (ready_at IS NOT NULL OR rejection_code='asset_reservation_expired')
        RETURNING owner_user_id, size_bytes, ready_at`,
        [asset.id],
      );
      if (asset.quota_bucket !== "none" && finalized.rowCount) {
        const row = finalized.rows[0]!;
        await client.query(`DELETE FROM asset_usage WHERE consumer=$1`, [
          `asset-derivative:${asset.id}`,
        ]);
        if (asset.quota_bucket === "used") {
          await client.query(
            `UPDATE account_asset_quota
                SET used_bytes=GREATEST(0, used_bytes-$2), updated_at=NOW()
              WHERE user_id=$1`,
            [row.owner_user_id, Number(row.size_bytes)],
          );
        } else {
          await client.query(
            `UPDATE account_asset_quota
                SET reserved_bytes=GREATEST(0, reserved_bytes-$2), updated_at=NOW()
              WHERE user_id=$1`,
            [row.owner_user_id, Number(row.size_bytes)],
          );
        }
        expired += 1;
      }
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original failure; the durable claim is retryable.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return { claimed: claimed.rowCount ?? claimed.rows.length, expired, pendingProviderCleanup };
}

let sweepTimer: NodeJS.Timeout | null = null;

export function startAssetReservationSweeperAfterMigrations(): void {
  if (sweepTimer || !assetR2Configured()) return;
  const run = (): void => {
    void sweepExpiredAssetReservations()
      .then((receipt) => {
        if (receipt.claimed > 0) logger.info(receipt, "expired asset reservations swept");
      })
      .catch((error: unknown) => {
        logger.error(
          { errorClass: error instanceof Error ? error.name : "unknown" },
          "expired asset reservation sweep failed",
        );
      });
  };
  run();
  sweepTimer = setInterval(run, ASSET_RESERVATION_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}
