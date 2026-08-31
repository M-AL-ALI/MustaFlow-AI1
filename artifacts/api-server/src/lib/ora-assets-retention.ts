/**
 * Ora Assets Retention Scheduler — Wave 2A
 *
 * Retires unreferenced ora_assets rows older than ORA_ASSETS_RETENTION_DAYS
 * (default 90 days) through the shared durable asset deletion path. The scheduler runs once 5 minutes after server
 * startup and then every 24 hours. Both timers are unref'd so they do not hold
 * the process open during graceful shutdown.
 *
 * Retention policy:
 *   - Default:  90 days from created_at
 *   - Override: ORA_ASSETS_RETENTION_DAYS=<n> env var
 *   - referenced assets are retained so a cleanup job cannot break a working
 *     file context, brand kit, support receipt, generated image, or project.
 *   - provider failures remain typed cleanup-pending and are retried later.
 */

import { db, oraAssetsTable } from "@workspace/db";
import { and, isNull, lt } from "drizzle-orm";
import { logger } from "./logger";
import { deleteOraAsset } from "./ora-assets";

const DEFAULT_RETENTION_DAYS = 90;
const INITIAL_DELAY_MS = 5 * 60 * 1000;
const INTERVAL_MS = 24 * 60 * 60 * 1000;

function retentionDays(): number {
  const raw = process.env.ORA_ASSETS_RETENTION_DAYS;
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

export async function runOraAssetsRetention(): Promise<void> {
  const days = retentionDays();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try {
    const candidates = await db
      .select({ id: oraAssetsTable.id, userId: oraAssetsTable.userId })
      .from(oraAssetsTable)
      .where(and(isNull(oraAssetsTable.deletedAt), lt(oraAssetsTable.createdAt, cutoff)))
      .limit(100);
    const totals = { deleted: 0, retained: 0, pending: 0 };
    for (const candidate of candidates) {
      const result = await deleteOraAsset({
        oraAssetId: candidate.id,
        userId: candidate.userId,
      });
      if (result === "deleted") totals.deleted += 1;
      else if (result === "cleanup-pending") totals.pending += 1;
      else totals.retained += 1;
    }
    logger.info(
      {
        component: "ora-assets-retention",
        candidateCount: candidates.length,
        deletedCount: totals.deleted,
        retainedCount: totals.retained,
        cleanupPendingCount: totals.pending,
        cutoffDays: days,
      },
      "Ora assets retention run complete",
    );
  } catch (err) {
    logger.error({ component: "ora-assets-retention", err }, "Ora assets retention run failed");
  }
}

export function startOraAssetsRetentionScheduler(): void {
  const initial = setTimeout(() => {
    void runOraAssetsRetention();
  }, INITIAL_DELAY_MS);
  initial.unref();

  const interval = setInterval(() => {
    void runOraAssetsRetention();
  }, INTERVAL_MS);
  interval.unref();
}
