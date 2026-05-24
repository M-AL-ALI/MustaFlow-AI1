// preview-purge.ts — daily cleanup of expired preview_snapshots rows.
//
// Imported once by app.ts. Runs immediately on startup and then every 24 h.
// Best-effort: errors are logged but never thrown.

import { lt } from "drizzle-orm";
import { db, previewSnapshotsTable } from "@workspace/db";
import { logger } from "./logger";

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function purgeExpiredPreviews(): Promise<void> {
  try {
    const result = await db
      .delete(previewSnapshotsTable)
      .where(lt(previewSnapshotsTable.expiresAt, new Date()));
    logger.info({ result }, "Expired preview snapshots purged");
  } catch (err) {
    logger.warn({ err }, "Failed to purge expired preview snapshots (non-fatal)");
  }
}

// Run immediately on startup, then on a daily schedule.
void purgeExpiredPreviews();
const timer = setInterval(() => {
  void purgeExpiredPreviews();
}, INTERVAL_MS);
// Allow Node.js to exit even if this timer is still pending.
timer.unref();
