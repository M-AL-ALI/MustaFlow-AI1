/**
 * Ora transcript inactivity TTL scheduler.
 *
 * Deletes ora_transcripts rows that have had no activity for longer than
 * ORA_TRANSCRIPT_RETENTION_DAYS (default 180 days). Activity is measured
 * via the updated_at column (last save time).
 *
 * Runs ~1 minute after server startup, then every 6 hours, matching the
 * pattern used by the container-log-retention scheduler.
 *
 * Graceful degradation: any DB error is logged and swallowed; the
 * scheduler keeps ticking on its interval.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

const RETENTION_DAYS = Number(process.env.ORA_TRANSCRIPT_RETENTION_DAYS ?? 180);
const INITIAL_DELAY_MS = 60_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface OraTranscriptPruneResult {
  deleted: number;
}

export async function pruneOraTranscripts(): Promise<OraTranscriptPruneResult> {
  let deleted = 0;

  if (!Number.isFinite(RETENTION_DAYS) || RETENTION_DAYS <= 0) {
    return { deleted };
  }

  try {
    const res = await db.execute(sql`
      DELETE FROM ora_transcripts
      WHERE updated_at < NOW() - (${RETENTION_DAYS} || ' days')::interval
    `);
    deleted = (res as unknown as { rowCount?: number }).rowCount ?? 0;
  } catch (err) {
    logger.warn({ err }, "ora transcript retention: prune failed");
  }

  if (deleted > 0) {
    logger.info(
      { deleted, retentionDays: RETENTION_DAYS },
      "ora transcript retention: pruned inactive transcripts",
    );
  } else {
    logger.debug({ retentionDays: RETENTION_DAYS }, "ora transcript retention: nothing to prune");
  }

  return { deleted };
}

export function startOraTranscriptRetentionScheduler(): void {
  logger.info(
    { initialDelayMs: INITIAL_DELAY_MS, intervalMs: INTERVAL_MS, retentionDays: RETENTION_DAYS },
    "ora transcript retention scheduler: starting",
  );

  setTimeout(() => {
    void pruneOraTranscripts().catch((err: unknown) => {
      logger.warn({ err }, "ora transcript retention: initial prune failed");
    });
    setInterval(() => {
      void pruneOraTranscripts().catch((err: unknown) => {
        logger.warn({ err }, "ora transcript retention: scheduled prune failed");
      });
    }, INTERVAL_MS);
  }, INITIAL_DELAY_MS);
}
