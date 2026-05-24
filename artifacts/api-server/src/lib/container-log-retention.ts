/**
 * Task #750 — Container log retention scheduler.
 *
 * The container log tailer (Task #746) persists every line of stdout/stderr
 * from agentic project machines into `container_logs`. Without retention
 * this table grows unbounded on long-lived projects, bloating the DB and
 * slowing down the SSE replay query on the workspace Logs tab.
 *
 * This scheduler periodically prunes old rows using two caps applied
 * per-project (whichever is more aggressive wins):
 *   - age cap: delete rows older than CONTAINER_LOG_RETENTION_DAYS
 *   - row cap: keep at most CONTAINER_LOG_MAX_ROWS_PER_PROJECT most recent rows
 *
 * Defaults (14 days / 10k rows per project) leave plenty of recent history
 * for the Logs tab replay snapshot (which only fetches the last few hundred
 * lines anyway) while keeping the table bounded.
 *
 * Graceful degradation: any DB error is logged and swallowed; the scheduler
 * keeps ticking on its interval.
 */

import { db, containerLogsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

const RETENTION_DAYS = Number(process.env.CONTAINER_LOG_RETENTION_DAYS ?? 14);
const MAX_ROWS_PER_PROJECT = Number(process.env.CONTAINER_LOG_MAX_ROWS_PER_PROJECT ?? 10_000);
const INITIAL_DELAY_MS = 60_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h

export interface ContainerLogPruneResult {
  ageDeleted: number;
  rowCapDeleted: number;
}

/**
 * Run one prune pass. Exported for tests and ad-hoc invocation.
 */
export async function pruneContainerLogs(): Promise<ContainerLogPruneResult> {
  let ageDeleted = 0;
  let rowCapDeleted = 0;

  // 1) Age-based prune: delete anything older than the retention window.
  if (Number.isFinite(RETENTION_DAYS) && RETENTION_DAYS > 0) {
    try {
      const res = await db.execute(sql`
        DELETE FROM container_logs
        WHERE created_at < NOW() - (${RETENTION_DAYS} || ' days')::interval
      `);
      ageDeleted = (res as unknown as { rowCount?: number }).rowCount ?? 0;
    } catch (err) {
      logger.warn({ err }, "container log retention: age-based prune failed");
    }
  }

  // 2) Per-project row cap: for each project that exceeds the cap, delete
  //    the oldest rows so only the most recent MAX_ROWS_PER_PROJECT remain.
  //    Uses a single CTE-based DELETE so we don't fan out queries per project.
  if (Number.isFinite(MAX_ROWS_PER_PROJECT) && MAX_ROWS_PER_PROJECT > 0) {
    try {
      const res = await db.execute(sql`
        WITH ranked AS (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY project_id
                   ORDER BY created_at DESC, id DESC
                 ) AS rn
          FROM container_logs
        )
        DELETE FROM container_logs
        WHERE id IN (SELECT id FROM ranked WHERE rn > ${MAX_ROWS_PER_PROJECT})
      `);
      rowCapDeleted = (res as unknown as { rowCount?: number }).rowCount ?? 0;
    } catch (err) {
      logger.warn({ err }, "container log retention: row-cap prune failed");
    }
  }

  if (ageDeleted > 0 || rowCapDeleted > 0) {
    logger.info(
      {
        ageDeleted,
        rowCapDeleted,
        retentionDays: RETENTION_DAYS,
        maxRowsPerProject: MAX_ROWS_PER_PROJECT,
      },
      "container log retention: pruned old rows",
    );
  } else {
    logger.debug(
      { retentionDays: RETENTION_DAYS, maxRowsPerProject: MAX_ROWS_PER_PROJECT },
      "container log retention: nothing to prune",
    );
  }

  // Touch the import so the symbol is considered used even if the table
  // schema reference is only required for type checking.
  void containerLogsTable;

  return { ageDeleted, rowCapDeleted };
}

export function startContainerLogRetentionScheduler(): void {
  logger.info(
    {
      initialDelayMs: INITIAL_DELAY_MS,
      intervalMs: INTERVAL_MS,
      retentionDays: RETENTION_DAYS,
      maxRowsPerProject: MAX_ROWS_PER_PROJECT,
    },
    "container log retention scheduler: starting",
  );

  setTimeout(() => {
    void pruneContainerLogs().catch((err: unknown) => {
      logger.warn({ err }, "container log retention: initial prune failed");
    });
    setInterval(() => {
      void pruneContainerLogs().catch((err: unknown) => {
        logger.warn({ err }, "container log retention: scheduled prune failed");
      });
    }, INTERVAL_MS);
  }, INITIAL_DELAY_MS);
}
