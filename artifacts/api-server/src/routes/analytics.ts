import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, buildAnalyticsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";

const router: IRouter = Router();

router.get("/projects/:id/analytics", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  if (!Number.isFinite(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const rows = await db
    .select()
    .from(buildAnalyticsTable)
    .where(eq(buildAnalyticsTable.projectId, projectId))
    .orderBy(desc(buildAnalyticsTable.createdAt))
    .limit(100);

  const total = rows.length;
  const succeeded = rows.filter((r) => r.outcome === "success").length;
  const successRate = total > 0 ? succeeded / total : null;
  const avgDurationMs =
    total > 0 ? Math.round(rows.reduce((sum, r) => sum + r.durationMs, 0) / total) : null;
  const avgCorrectionPasses =
    total > 0 ? rows.reduce((sum, r) => sum + r.correctionPasses, 0) / total : null;

  const errorCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.primaryErrorCategory) {
      errorCounts.set(r.primaryErrorCategory, (errorCounts.get(r.primaryErrorCategory) ?? 0) + 1);
    }
  }
  let topErrorCategory: string | null = null;
  let topCount = 0;
  for (const [cat, cnt] of errorCounts) {
    if (cnt > topCount) {
      topCount = cnt;
      topErrorCategory = cat;
    }
  }

  res.json({
    rows,
    summary: {
      total,
      successRate,
      avgDurationMs,
      avgCorrectionPasses,
      topErrorCategory,
    },
  });
});

export default router;
