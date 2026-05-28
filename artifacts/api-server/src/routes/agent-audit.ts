/**
 * GET /api/projects/:id/agent-audit
 *
 * Returns the most recent agent tool-call records for a project, paginated.
 * Powers the "Agent Audit" sub-tab in the Logs view.
 *
 * Query params:
 *   limit  – number of rows to return (default 50, max 200)
 *   offset – row offset for pagination (default 0)
 *   taskId – filter to a specific task (optional)
 */

import { Router, type IRouter } from "express";
import { desc, eq, and } from "drizzle-orm";
import { db, agentToolCallsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get(
  "/projects/:id/agent-audit",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const rawLimit = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 200) : 50;

    const rawOffset = Number(req.query.offset ?? 0);
    const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

    const rawTaskId = req.query.taskId ? Number(req.query.taskId) : null;
    const taskIdFilter = rawTaskId !== null && Number.isFinite(rawTaskId) ? rawTaskId : null;

    try {
      const where =
        taskIdFilter !== null
          ? and(
              eq(agentToolCallsTable.projectId, projectId),
              eq(agentToolCallsTable.taskId, taskIdFilter),
            )
          : eq(agentToolCallsTable.projectId, projectId);

      const rows = await db
        .select({
          id: agentToolCallsTable.id,
          taskId: agentToolCallsTable.taskId,
          toolName: agentToolCallsTable.toolName,
          argsSummary: agentToolCallsTable.argsSummary,
          stdoutPreview: agentToolCallsTable.stdoutPreview,
          exitCode: agentToolCallsTable.exitCode,
          ok: agentToolCallsTable.ok,
          durationMs: agentToolCallsTable.durationMs,
          calledAt: agentToolCallsTable.calledAt,
        })
        .from(agentToolCallsTable)
        .where(where)
        .orderBy(desc(agentToolCallsTable.calledAt))
        .limit(limit)
        .offset(offset);

      res.json({ rows, limit, offset });
    } catch (err) {
      logger.error({ err, projectId }, "Failed to fetch agent audit log");
      res.status(500).json({ error: "Failed to fetch agent audit log" });
    }
  },
);

export default router;
