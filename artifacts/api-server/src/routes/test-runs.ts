import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, appTestRunsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/projects/:id/test-runs", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  if (!Number.isFinite(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const limitParam = req.query.limit ? Number(req.query.limit) : undefined;
  const limit =
    limitParam !== undefined && Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, 100)
      : 20;

  try {
    const rows = await db
      .select()
      .from(appTestRunsTable)
      .where(eq(appTestRunsTable.projectId, projectId))
      .orderBy(desc(appTestRunsTable.ranAt))
      .limit(limit);

    res.json(rows);
  } catch (err) {
    logger.error({ err, projectId }, "Failed to fetch test runs");
    res.status(500).json({ error: "Failed to fetch test runs" });
  }
});

export default router;
