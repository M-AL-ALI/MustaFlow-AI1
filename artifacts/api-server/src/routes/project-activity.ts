import { Router, type IRouter } from "express";
import { and, eq, desc, inArray } from "drizzle-orm";
import { agentTasksTable, db, projectActivityTable, taskEventsTable } from "@workspace/db";
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

    const projectRows = await db
      .select()
      .from(projectActivityTable)
      .where(and(...conditions))
      .orderBy(desc(projectActivityTable.createdAt))
      .limit(limit);

    const includeTaskEvents =
      eventType === undefined || eventType === "build" || eventType === "build_failed";
    const persistedTaskEvents = includeTaskEvents
      ? await db
          .select({
            id: taskEventsTable.id,
            taskId: taskEventsTable.taskId,
            eventType: taskEventsTable.eventType,
            message: taskEventsTable.message,
            data: taskEventsTable.data,
            createdAt: taskEventsTable.createdAt,
          })
          .from(taskEventsTable)
          .innerJoin(agentTasksTable, eq(agentTasksTable.id, taskEventsTable.taskId))
          .where(
            and(
              eq(agentTasksTable.projectId, projectId),
              eq(agentTasksTable.status, "completed"),
              inArray(taskEventsTable.eventType, ["completed", "failed"]),
            ),
          )
          .orderBy(desc(taskEventsTable.createdAt))
          .limit(limit)
      : [];

    const taskRows = persistedTaskEvents
      .map((event) => {
        const mappedEventType = event.eventType === "failed" ? "build_failed" : "build";
        return {
          id: -event.id,
          projectId,
          actorId: null,
          actorName: "Agent Zero",
          actorAvatar: null,
          eventType: mappedEventType,
          summary: event.message,
          metadata: {
            ...(event.data ?? {}),
            source: "task_event",
            taskId: event.taskId,
            taskEventType: event.eventType,
          },
          createdAt: event.createdAt,
        };
      })
      .filter((event) => eventType === undefined || event.eventType === eventType);

    const rows = [...projectRows, ...taskRows]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);

    res.json(rows);
  },
);

export default router;
