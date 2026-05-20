import { Router, type IRouter } from "express";
import { desc, eq, isNotNull } from "drizzle-orm";
import { db, projectVersionsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get(
  "/projects/:id/audit",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    try {
      // Return the most recent version that has a completed audit report.
      // This handles the async lag between version creation and audit completion —
      // the audit runs in setImmediate after the task is already marked "completed",
      // so we look back up to 10 versions to find the freshest audited one.
      const versions = await db
        .select({
          id: projectVersionsTable.id,
          auditReport: projectVersionsTable.auditReport,
          createdAt: projectVersionsTable.createdAt,
        })
        .from(projectVersionsTable)
        .where(eq(projectVersionsTable.projectId, projectId))
        .orderBy(desc(projectVersionsTable.createdAt))
        .limit(10);

      if (versions.length === 0) {
        res.status(404).json({ error: "No versions found for this project" });
        return;
      }

      const withAudit = versions.find((v) => v.auditReport != null);

      if (!withAudit) {
        res.status(404).json({ error: "No audit report available yet. Build or refine your app to generate one." });
        return;
      }

      res.json(withAudit.auditReport);
    } catch (err) {
      logger.error({ err, projectId }, "Failed to fetch audit report");
      res.status(500).json({ error: "Failed to fetch audit report" });
    }
  },
);

export default router;
