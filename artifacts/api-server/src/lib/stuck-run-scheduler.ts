/**
 * Stuck-run scheduler (Task #1182).
 *
 * Every 2 minutes, finds agent_tasks rows that are in status "building" but
 * have not received a heartbeat in the last 5 minutes, and marks them as
 * "failed" with a failure_reason of "stuck-run-timeout". This prevents builds
 * that crashed without writing a final status from staying in "building" forever.
 *
 * The scheduler uses setInterval(...).unref() so it never blocks graceful
 * shutdown. All errors are swallowed so one bad sweep never crashes the server.
 */

import { db, agentTasksTable } from "@workspace/db";
import { and, eq, lt, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";

const SWEEP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function sweepStuckRuns(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS);

    // Tasks that are still "building" but whose heartbeat is older than 5 min
    // (or never sent a heartbeat and started more than 5 min ago).
    const result = await db
      .update(agentTasksTable)
      .set({
        status: "failed",
        failureReason: "stuck-run-timeout",
      })
      .where(
        and(
          eq(agentTasksTable.status, "building"),
          sql`(
            (${agentTasksTable.lastHeartbeatAt} IS NOT NULL AND ${agentTasksTable.lastHeartbeatAt} < ${cutoff})
            OR
            (${agentTasksTable.lastHeartbeatAt} IS NULL AND ${agentTasksTable.createdAt} < ${cutoff})
          )`,
        ),
      )
      .returning({ id: agentTasksTable.id });

    if (result.length > 0) {
      logger.warn(
        { count: result.length, taskIds: result.map((r) => r.id) },
        "stuck-run-scheduler: marked stuck builds as failed",
      );
    }
  } catch (err) {
    logger.error({ err }, "stuck-run-scheduler: sweep failed");
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startStuckRunScheduler(): void {
  if (sweepTimer) return; // already started

  // Initial sweep after 1 min (let the server warm up first).
  setTimeout(() => void sweepStuckRuns(), 60_000).unref();

  sweepTimer = setInterval(() => void sweepStuckRuns(), SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  logger.info("stuck-run-scheduler: started (sweep every 2 min, timeout 5 min)");
}

export function stopStuckRunScheduler(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
