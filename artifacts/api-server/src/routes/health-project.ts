/**
 * Per-project health metrics endpoint.
 *
 * GET /api/projects/:id/health
 *
 * Returns aggregated build metrics, task failure rates, and recent incidents
 * for a specific project over 24h / 7d / 30d windows.
 * Reads from agent_tasks + deployment_logs tables.
 */

import { Router, type IRouter } from "express";
import { eq, and, gte, sql, desc } from "drizzle-orm";
import { db, agentTasksTable, deploymentLogsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";

const router: IRouter = Router();

type Window = "24h" | "7d" | "30d";

function windowToMs(w: Window): number {
  switch (w) {
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return 30 * 24 * 60 * 60 * 1000;
  }
}

function windowLabel(w: Window): string {
  return { "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days" }[w];
}

interface TaskMetrics {
  total: number;
  succeeded: number;
  failed: number;
  successRate: number;
  avgDurationMs: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  p99DurationMs: number | null;
}

interface WindowMetrics {
  window: Window;
  windowLabel: string;
  tasks: TaskMetrics;
  deployments: {
    published: number;
    unpublished: number;
  };
}

interface RecentIncident {
  at: string;
  kind: "build_failure" | "publish_failure";
  message: string;
}

router.get("/projects/:id/health", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);

  const windows: Window[] = ["24h", "7d", "30d"];
  const windowResults: WindowMetrics[] = [];

  for (const w of windows) {
    const since = new Date(Date.now() - windowToMs(w));

    const taskRows = await db
      .select({
        status: agentTasksTable.status,
        startedAt: agentTasksTable.startedAt,
        completedAt: agentTasksTable.completedAt,
      })
      .from(agentTasksTable)
      .where(and(eq(agentTasksTable.projectId, projectId), gte(agentTasksTable.createdAt, since)));

    const terminal = taskRows.filter((r) =>
      ["done", "failed", "error", "canceled", "completed"].includes(r.status),
    );
    const succeeded = terminal.filter((r) => ["done", "completed"].includes(r.status)).length;
    const failed = terminal.filter((r) => ["failed", "error"].includes(r.status)).length;
    const total = taskRows.length;

    const durations = terminal
      .filter((r) => r.startedAt && r.completedAt)
      .map((r) => r.completedAt!.getTime() - r.startedAt!.getTime())
      .sort((a, b) => a - b);

    const avg = durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null;

    function percentile(arr: number[], p: number): number | null {
      if (!arr.length) return null;
      const idx = Math.ceil((p / 100) * arr.length) - 1;
      return arr[Math.max(0, idx)] ?? null;
    }

    const deployRows = await db
      .select({ status: deploymentLogsTable.status })
      .from(deploymentLogsTable)
      .where(
        and(
          eq(deploymentLogsTable.projectId, projectId),
          gte(deploymentLogsTable.createdAt, since),
        ),
      );

    windowResults.push({
      window: w,
      windowLabel: windowLabel(w),
      tasks: {
        total,
        succeeded,
        failed,
        successRate: total > 0 ? Math.round((succeeded / total) * 1000) / 10 : 100,
        avgDurationMs: avg,
        p50DurationMs: percentile(durations, 50),
        p95DurationMs: percentile(durations, 95),
        p99DurationMs: percentile(durations, 99),
      },
      deployments: {
        published: deployRows.filter((d) => d.status !== "unpublished").length,
        unpublished: deployRows.filter((d) => d.status === "unpublished").length,
      },
    });
  }

  // Recent incidents — last 20 failed tasks
  const recentFailures = await db
    .select({
      completedAt: agentTasksTable.completedAt,
      status: agentTasksTable.status,
      title: agentTasksTable.title,
    })
    .from(agentTasksTable)
    .where(
      and(
        eq(agentTasksTable.projectId, projectId),
        sql`${agentTasksTable.status} IN ('failed', 'error')`,
      ),
    )
    .orderBy(desc(agentTasksTable.completedAt))
    .limit(20);

  const incidents: RecentIncident[] = recentFailures.map((r) => ({
    at: (r.completedAt ?? new Date()).toISOString(),
    kind: "build_failure" as const,
    message: r.title ?? "Build failed",
  }));

  res.json({
    projectId,
    generatedAt: new Date().toISOString(),
    windows: windowResults,
    recentIncidents: incidents,
  });
});

export default router;
