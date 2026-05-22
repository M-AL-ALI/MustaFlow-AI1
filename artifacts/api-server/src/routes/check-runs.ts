import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, checkRunsTable, projectFilesTable, agentTasksTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { logger } from "../lib/logger";
import { runOnDemandChecks } from "../lib/checks/orchestrator";
import { CHECK_REGISTRY } from "../lib/checks/registry";

const router: IRouter = Router();

router.get("/projects/:id/check-runs", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  if (!Number.isFinite(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const taskId = req.query.taskId ? Number(req.query.taskId) : undefined;
  if (req.query.taskId !== undefined && !Number.isFinite(taskId)) {
    res.status(400).json({ error: "Invalid taskId" });
    return;
  }

  const limitParam = req.query.limit ? Number(req.query.limit) : undefined;
  const limit =
    limitParam !== undefined && Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, 200)
      : taskId !== undefined
        ? 50
        : 20;

  try {
    const conditions = [eq(checkRunsTable.projectId, projectId)];
    if (taskId !== undefined) {
      conditions.push(eq(checkRunsTable.taskId, taskId));
    }

    const rows = await db
      .select()
      .from(checkRunsTable)
      .where(and(...conditions))
      .orderBy(desc(checkRunsTable.ranAt))
      .limit(limit);

    res.json(rows);
  } catch (err) {
    logger.error({ err, projectId }, "Failed to fetch check runs");
    res.status(500).json({ error: "Failed to fetch check runs" });
  }
});

router.get(
  "/projects/:id/check-runs/trends",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const rawWindow = Number(req.query.window);
    const windowSize = Number.isFinite(rawWindow) && rawWindow >= 1 ? Math.min(rawWindow, 100) : 20;

    try {
      const rows = await db
        .select({
          checkName: checkRunsTable.checkName,
          status: checkRunsTable.status,
          ranAt: checkRunsTable.ranAt,
        })
        .from(checkRunsTable)
        .where(eq(checkRunsTable.projectId, projectId))
        .orderBy(desc(checkRunsTable.ranAt))
        .limit(windowSize * 20);

      const byName = new Map<string, Array<{ ranAt: string; status: string }>>();
      for (const row of rows) {
        if (!byName.has(row.checkName)) byName.set(row.checkName, []);
        const arr = byName.get(row.checkName)!;
        if (arr.length < windowSize) {
          arr.push({ ranAt: row.ranAt.toISOString(), status: row.status });
        }
      }

      const trends = Array.from(byName.entries()).map(([checkName, history]) => ({
        checkName,
        history: [...history].reverse(),
      }));

      res.json({ trends, window: windowSize });
    } catch (err) {
      logger.error({ err, projectId }, "Failed to fetch check-run trends");
      res.status(500).json({ error: "Failed to fetch check-run trends" });
    }
  },
);

router.post(
  "/projects/:id/check-runs/trigger",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const body = req.body as { checks?: string[]; taskId?: number; onDemand?: boolean };
    const requestedChecks: string[] = Array.isArray(body.checks) ? body.checks : [];
    const isOnDemand = body.onDemand === true;

    const validCheckNames = new Set(CHECK_REGISTRY.map((c) => c.name));

    const checksToRun: string[] = isOnDemand
      ? ["sast", "secret-leak", "cdn-security"]
      : requestedChecks.filter((c) => validCheckNames.has(c));

    if (checksToRun.length === 0) {
      res.status(400).json({ error: "No valid checks specified" });
      return;
    }

    let taskIdForRun: number | undefined;
    if (body.taskId && Number.isFinite(body.taskId)) {
      taskIdForRun = body.taskId;
    } else {
      const [latestTask] = await db
        .select({ id: agentTasksTable.id })
        .from(agentTasksTable)
        .where(
          and(eq(agentTasksTable.projectId, projectId), eq(agentTasksTable.status, "completed")),
        )
        .orderBy(desc(agentTasksTable.completedAt))
        .limit(1);
      taskIdForRun = latestTask?.id;
    }

    try {
      const files = await db
        .select()
        .from(projectFilesTable)
        .where(eq(projectFilesTable.projectId, projectId));

      if (files.length === 0) {
        res.status(400).json({ error: "No project files to scan" });
        return;
      }

      const builderFiles = files.map((f) => ({
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
      }));

      const results = await runOnDemandChecks(builderFiles, checksToRun);

      if (results.length > 0 && taskIdForRun !== undefined) {
        await db.insert(checkRunsTable).values(
          results.map((r) => ({
            projectId,
            taskId: taskIdForRun,
            checkName: r.checkName,
            status: r.status,
            findings: r.findings,
            aiReason: r.aiReason,
          })),
        );
      }

      res.json({ runs: results });
    } catch (err) {
      logger.error({ err, projectId }, "Failed to trigger check runs");
      res.status(500).json({ error: "Failed to trigger checks" });
    }
  },
);

export default router;
