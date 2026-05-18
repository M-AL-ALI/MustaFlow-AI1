// ─────────────────────────────────────────────────────────────────────────────
// Deployment history — GET /api/projects/:id/deployments
// Returns the last 50 deployment log entries for a project.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, deploymentLogsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";

const router: IRouter = Router();

router.get(
  "/projects/:id/deployments",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const rows = await db
      .select()
      .from(deploymentLogsTable)
      .where(eq(deploymentLogsTable.projectId, projectId))
      .orderBy(desc(deploymentLogsTable.createdAt))
      .limit(50);

    res.json({ deployments: rows });
  },
);

export default router;
