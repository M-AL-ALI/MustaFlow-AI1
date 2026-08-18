/**
 * /api/v1/projects/:id/builds — trigger and poll AI builds via the public REST API.
 *
 * Auth: Bearer PAT token OR Clerk session cookie (handled by v1AuthMiddleware).
 *
 * Routes:
 *   GET  /api/v1/projects/:id/builds            — list builds (tasks) for a project
 *   GET  /api/v1/projects/:id/builds/:buildId   — poll a specific build
 *   POST /api/v1/projects/:id/builds            — trigger a new build
 *   POST /api/v1/projects/:id/builds/:buildId/cancel — cancel a build
 */

import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, projectsTable, agentTasksTable } from "@workspace/db";
import { enqueueJob, cancelActiveJob } from "../../lib/jobs";
import { logger } from "../../lib/logger";
import { checkV1ProjectAccess, requirePatScope } from "./access";

const router: IRouter = Router();

/** Shape a task row into the public build representation. */
function formatBuild(task: typeof agentTasksTable.$inferSelect) {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    prompt: task.prompt,
    status: task.status,
    kind: task.kind,
    agentMode: task.taskAgentMode,
    elapsedSeconds:
      task.completedAt && (task.startedAt ?? task.createdAt)
        ? Math.round(
            (task.completedAt.getTime() - (task.startedAt ?? task.createdAt).getTime()) / 1000,
          )
        : null,
    result: task.result,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
  };
}

// ── GET /api/v1/projects/:id/builds ──────────────────────────────────────────
router.get(
  "/projects/:id/builds",
  requirePatScope("builds:read"),
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }

    if (!(await checkV1ProjectAccess(req, projectId))) {
      res.status(404).json({ error: "Project not found." });
      return;
    }

    const limitRaw = parseInt((req.query.limit as string) ?? "20", 10);
    const limit = Math.min(Math.max(1, isNaN(limitRaw) ? 20 : limitRaw), 100);

    const tasks = await db
      .select()
      .from(agentTasksTable)
      .where(eq(agentTasksTable.projectId, projectId))
      .orderBy(desc(agentTasksTable.createdAt))
      .limit(limit);

    res.json({ builds: tasks.map(formatBuild), total: tasks.length });
  },
);

// ── GET /api/v1/projects/:id/builds/:buildId ──────────────────────────────────
router.get(
  "/projects/:id/builds/:buildId",
  requirePatScope("builds:read"),
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const buildId = Number(req.params.buildId);
    if (!Number.isFinite(projectId) || !Number.isFinite(buildId)) {
      res.status(400).json({ error: "Invalid project id or build id." });
      return;
    }

    if (!(await checkV1ProjectAccess(req, projectId))) {
      res.status(404).json({ error: "Project not found." });
      return;
    }

    const [task] = await db
      .select()
      .from(agentTasksTable)
      .where(and(eq(agentTasksTable.id, buildId), eq(agentTasksTable.projectId, projectId)));

    if (!task) {
      res.status(404).json({ error: "Build not found." });
      return;
    }

    res.json({ build: formatBuild(task) });
  },
);

// ── POST /api/v1/projects/:id/builds ─────────────────────────────────────────
router.post(
  "/projects/:id/builds",
  requirePatScope("builds:trigger"),
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }

    if (!(await checkV1ProjectAccess(req, projectId, "member"))) {
      res.status(404).json({ error: "Project not found." });
      return;
    }

    const { prompt } = req.body as { prompt?: unknown };
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      res.status(400).json({ error: "prompt is required." });
      return;
    }

    const trimmedPrompt = prompt.trim().slice(0, 2000);

    // Fetch the project to read agentMode and current status.
    const [project] = await db
      .select({
        id: projectsTable.id,
        agentMode: projectsTable.agentMode,
        status: projectsTable.status,
        ownerId: projectsTable.ownerId,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));

    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }

    // NabuFlow billing gate (Task #1516) — the public API build trigger passes
    // the same server-side resolver as every other build entry point.
    if (project.ownerId) {
      const { creditCostFor, resolveStageProvider } = await import("../../lib/ai-providers");
      const gateMode = project.agentMode as Parameters<typeof creditCostFor>[0];
      const { provider } = resolveStageProvider("build", gateMode);
      const { nabuflowGateHttpError } = await import("../../lib/nabuflow-billing");
      const gateErr = await nabuflowGateHttpError(project.ownerId, {
        engineMode: gateMode,
        deepReasoning: false,
        projectedCredits: creditCostFor(gateMode, provider, false),
        source: "pipeline",
      });
      if (gateErr) {
        res.status(gateErr.status).json(gateErr.body);
        return;
      }
    }

    // Check if a build is already active — queue if so.
    const activeTasks = await db
      .select({ id: agentTasksTable.id })
      .from(agentTasksTable)
      .where(
        and(
          eq(agentTasksTable.projectId, projectId),
          inArray(agentTasksTable.status, ["building", "planning"]),
        ),
      )
      .limit(1);

    const hasActiveBuild = activeTasks.length > 0;

    const [task] = await db
      .insert(agentTasksTable)
      .values({
        projectId: project.id,
        title: trimmedPrompt.slice(0, 140),
        kind: "main",
        status: hasActiveBuild ? "queued" : "planning",
        prompt: trimmedPrompt,
        taskAgentMode: project.agentMode,
      })
      .returning();

    if (!task) {
      res.status(500).json({ error: "Failed to create build." });
      return;
    }

    await db
      .update(projectsTable)
      .set({
        status: hasActiveBuild ? project.status : "building",
        lastTaskSummary: trimmedPrompt.slice(0, 140),
        updatedAt: sql`now()`,
      })
      .where(eq(projectsTable.id, projectId));

    if (!hasActiveBuild) {
      const [fileExists] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(sql`(select 1 from project_files where project_id = ${projectId} limit 1) as f`);

      const jobKind = (fileExists?.c ?? 0) > 0 ? "refine" : "build";

      enqueueJob({
        taskId: task.id,
        projectId: project.id,
        kind: jobKind,
        userPrompt: trimmedPrompt,
        agentMode: project.agentMode as "lite" | "eco" | "power" | "pro",
      });
    }

    res.status(202).json({
      build: formatBuild(task),
      queued: hasActiveBuild,
      message: hasActiveBuild
        ? "Build queued — another build is currently running."
        : "Build started. Poll GET /api/v1/projects/:id/builds/:buildId for status.",
    });
  },
);

// ── POST /api/v1/projects/:id/builds/:buildId/cancel ──────────────────────────
router.post(
  "/projects/:id/builds/:buildId/cancel",
  requirePatScope("builds:trigger"),
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const buildId = Number(req.params.buildId);
    if (!Number.isFinite(projectId) || !Number.isFinite(buildId)) {
      res.status(400).json({ error: "Invalid project id or build id." });
      return;
    }

    if (!(await checkV1ProjectAccess(req, projectId, "member"))) {
      res.status(404).json({ error: "Project not found." });
      return;
    }

    const [task] = await db
      .select()
      .from(agentTasksTable)
      .where(and(eq(agentTasksTable.id, buildId), eq(agentTasksTable.projectId, projectId)));

    if (!task) {
      res.status(404).json({ error: "Build not found." });
      return;
    }

    if (!["queued", "planning", "building"].includes(task.status)) {
      res.status(409).json({
        error: `Build cannot be cancelled (current status: ${task.status}).`,
      });
      return;
    }

    cancelActiveJob(buildId);

    await db
      .update(agentTasksTable)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(
        and(
          eq(agentTasksTable.id, buildId),
          inArray(agentTasksTable.status, ["queued", "planning", "building"]),
        ),
      );

    logger.info({ buildId, projectId }, "v1 build cancelled");
    res.json({ cancelled: true, buildId });
  },
);

export default router;
