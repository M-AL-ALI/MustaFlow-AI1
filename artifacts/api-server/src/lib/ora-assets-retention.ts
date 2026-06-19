/**
 * Ora Assets Retention Scheduler — Wave 2A
 *
 * Soft-deletes ora_assets rows older than ORA_ASSETS_RETENTION_DAYS (default 90
 * days) by setting deleted_at. The scheduler runs once 5 minutes after server
 * startup and then every 24 hours. Both timers are unref'd so they do not hold
 * the process open during graceful shutdown.
 *
 * Retention policy:
 *   - Default:  90 days from created_at
 *   - Override: ORA_ASSETS_RETENTION_DAYS=<n> env var
 *   - R2-offloaded assets are soft-deleted (storage_key kept; R2 objects are
 *     not purged here to avoid accidental data loss — a separate R2 lifecycle
 *     rule should handle final object deletion after the DB row is gone).
 */

import { db, oraAssetsTable } from "@workspace/db";
import { and, isNull, lt } from "drizzle-orm";
import { logger } from "./logger";

const DEFAULT_RETENTION_DAYS = 90;
const INITIAL_DELAY_MS = 5 * 60 * 1000;
const INTERVAL_MS = 24 * 60 * 60 * 1000;

function retentionDays(): number {
  const raw = process.env.ORA_ASSETS_RETENTION_DAYS;
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

async function runOraAssetsRetention(): Promise<void> {
  const days = retentionDays();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try {
    const result = await db
      .update(oraAssetsTable)
      .set({ deletedAt: new Date() })
      .where(and(isNull(oraAssetsTable.deletedAt), lt(oraAssetsTable.createdAt, cutoff)));
    logger.info(
      { component: "ora-assets-retention", deletedCount: result.rowCount ?? 0, cutoffDays: days },
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
