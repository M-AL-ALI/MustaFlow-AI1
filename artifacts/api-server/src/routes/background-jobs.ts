import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, projectsTable, agentTasksTable } from "@workspace/db";
import { ListBackgroundJobsResponse } from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const ACTIVE_STATUSES = ["queued", "planning", "building", "needs_review"] as const;

router.get("/background-jobs", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const limitRaw = Number(req.query["limit"] ?? 30);
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 30));
  const statusFilter = req.query["status"] === "all" ? "all" : "active";

  try {
    const rows = await db
      .select({
        id: agentTasksTable.id,
        projectId: agentTasksTable.projectId,
        projectName: projectsTable.name,
        title: agentTasksTable.title,
        status: agentTasksTable.status,
        runMode: agentTasksTable.runMode,
        creditsReserved: agentTasksTable.creditsReserved,
        createdAt: agentTasksTable.createdAt,
        startedAt: agentTasksTable.startedAt,
        completedAt: agentTasksTable.completedAt,
      })
      .from(agentTasksTable)
      .innerJoin(projectsTable, eq(projectsTable.id, agentTasksTable.projectId))
      .where(
        and(
          eq(projectsTable.ownerId, userId),
          isNull(projectsTable.deletedAt),
          eq(agentTasksTable.runMode, "background"),
          statusFilter === "active"
            ? inArray(agentTasksTable.status, ACTIVE_STATUSES as unknown as string[])
            : sql`true`,
        ),
      )
      .orderBy(desc(agentTasksTable.createdAt))
      .limit(limit);

    const payload = {
      jobs: rows.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        projectName: r.projectName,
        title: r.title ?? "",
        status: r.status,
        runMode: (r.runMode ?? "background") as "foreground" | "background",
        creditsReserved: r.creditsReserved ?? null,
        createdAt: (r.createdAt instanceof Date
          ? r.createdAt.toISOString()
          : String(r.createdAt)) as string,
        startedAt: r.startedAt instanceof Date ? r.startedAt.toISOString() : (r.startedAt ?? null),
        completedAt:
          r.completedAt instanceof Date ? r.completedAt.toISOString() : (r.completedAt ?? null),
      })),
    };

    // Validate before sending (uses generated Zod schema with date coercion).
    res.json(ListBackgroundJobsResponse.parse(payload));
  } catch (err) {
    logger.error({ err, userId }, "Failed to list background jobs");
    res.status(500).json({ error: "Failed to list background jobs" });
  }
});

export default router;
