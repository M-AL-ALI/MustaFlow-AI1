import { Router, type IRouter } from "express";
import { and, eq, desc } from "drizzle-orm";
import { db, projectActivityTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";

// Express v5 types params as string | string[] — extract the scalar value.
const pstr = (v: string | string[]): string => (Array.isArray(v) ? (v[0] ?? "") : v);

const router: IRouter = Router();

// ── List activity for a project ───────────────────────────────────────────────
router.get(
  "/projects/:id/activity-log",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = parseInt(pstr(req.params.id), 10);
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 200);
    const eventType = typeof req.query.eventType === "string" ? req.query.eventType : undefined;

    const conditions = [eq(projectActivityTable.projectId, projectId)];
    if (eventType) conditions.push(eq(projectActivityTable.eventType, eventType));

    const rows = await db
      .select()
      .from(projectActivityTable)
      .where(and(...conditions))
      .orderBy(desc(projectActivityTable.createdAt))
      .limit(limit);

    res.json(rows);
  },
);

export default router;
