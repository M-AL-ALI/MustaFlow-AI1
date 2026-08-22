/**
 * Stuck-run scheduler (Task #1182).
 *
 * Every 2 minutes, finds agent_tasks rows that are executing but
 * have not received a heartbeat in the last 5 minutes, and marks them as
 * "failed" with a failure_reason of "stuck-run-timeout". This prevents builds
 * that crashed without writing a final status from staying active forever.
 *
 * The scheduler uses setInterval(...).unref() so it never blocks graceful
 * shutdown. All errors are swallowed so one bad sweep never crashes the server.
 */

import { db, agentTasksTable, taskEventsTable } from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { logger } from "./logger";
import { drainNextProjectTask } from "./jobs";

const SWEEP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
// 8 minutes: Fly.io machine cold-wake can take 3–4 min; add ≥3 min safety
// margin so transient slow-wake doesn't trigger a false stuck-run kill.
const HEARTBEAT_TIMEOUT_MS = 8 * 60 * 1000; // 8 minutes
// A foreground task normally leaves planning in the same request turn. A row
// still there after two minutes has survived its dispatcher (request/process
// loss or pre-dispatch failure) and must be adopted from durable state.
export const PLANNING_DISPATCH_TIMEOUT_MS = 2 * 60 * 1000;

export async function sweepStuckRuns(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS);
    const planningCutoff = new Date(Date.now() - PLANNING_DISPATCH_TIMEOUT_MS);

    // Atomically claim stale, never-started planning rows for recovery. Across
    // replicas only the updater that actually changed the row receives it in
    // RETURNING and is therefore allowed to nudge the durable queue.
    const recoveredPlanning = await db
      .update(agentTasksTable)
      .set({ status: "queued" })
      .where(
        and(
          eq(agentTasksTable.status, "planning"),
          sql`${agentTasksTable.startedAt} IS NULL`,
          sql`${agentTasksTable.createdAt} < ${planningCutoff}`,
        ),
      )
      .returning({ id: agentTasksTable.id, projectId: agentTasksTable.projectId });

    for (const task of recoveredPlanning) {
      await db.insert(taskEventsTable).values({
        taskId: task.id,
        eventType: "dispatch_recovered",
        message: "Recovered a task whose original dispatcher did not survive.",
        filePath: null,
      });
      void drainNextProjectTask(task.projectId, task.id).catch((err) =>
        logger.warn(
          { err, taskId: task.id, projectId: task.projectId },
          "stuck-run-scheduler: failed to nudge recovered planning task",
        ),
      );
    }

    const message =
      "Task timed out because Agent Zero stopped sending progress heartbeats. Please retry or inspect the last task events.";

    // Tasks that are still executing (building or answering) but whose heartbeat is older than the
    // timeout window (or never sent a heartbeat and started before the cutoff).
    const result = await db
      .update(agentTasksTable)
      .set({
        status: "failed",
        result: message,
        failureReason: "stuck-run-timeout",
        completedAt: sql`now()`,
      })
      .where(
        and(
          inArray(agentTasksTable.status, ["building", "answering"]),
          sql`(
            (${agentTasksTable.lastHeartbeatAt} IS NOT NULL AND ${agentTasksTable.lastHeartbeatAt} < ${cutoff})
            OR
            (${agentTasksTable.lastHeartbeatAt} IS NULL AND ${agentTasksTable.createdAt} < ${cutoff})
          )`,
        ),
      )
      .returning({ id: agentTasksTable.id, projectId: agentTasksTable.projectId });

    if (result.length > 0) {
      await db.insert(taskEventsTable).values(
        result.map((r) => ({
          taskId: r.id,
          eventType: "failed",
          message,
          filePath: null,
        })),
      );
      logger.warn(
        { count: result.length, taskIds: result.map((r) => r.id) },
        "stuck-run-scheduler: marked stuck builds as failed",
      );
      for (const task of result) {
        void drainNextProjectTask(task.projectId).catch((err) =>
          logger.warn(
            { err, taskId: task.id, projectId: task.projectId },
            "stuck-run-scheduler: failed to drain after terminalizing stuck build",
          ),
        );
      }
    }

    if (recoveredPlanning.length > 0) {
      logger.warn(
        {
          count: recoveredPlanning.length,
          taskIds: recoveredPlanning.map((task) => task.id),
        },
        "stuck-run-scheduler: adopted stale planning tasks",
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

  logger.info("stuck-run-scheduler: started (sweep every 2 min, timeout 8 min)");
}

export function stopStuckRunScheduler(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
