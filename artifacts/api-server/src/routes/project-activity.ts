import { Router, type IRouter } from "express";
import { and, eq, desc, inArray } from "drizzle-orm";
import { agentTasksTable, db, projectActivityTable, taskEventsTable } from "@workspace/db";
import { z } from "zod";
import { requireProjectOwnership } from "../lib/auth";

const positiveId = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().max(2147483647));
const activityQuery = z.object({
  limit: positiveId.optional(),
  eventType: z.string().min(1).max(64).optional(),
});

const router: IRouter = Router();

// ── List activity for a project ───────────────────────────────────────────────
router.get(
  "/projects/:id/activity-log",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const project = positiveId.safeParse(req.params.id);
    const query = activityQuery.safeParse(req.query);
    if (!project.success || !query.success) {
      res.status(400).json({ error: "Invalid activity request" });
      return;
    }
    const projectId = project.data;
    const limit = Math.min(query.data.limit ?? 50, 200);
    const eventType = query.data.eventType;

    const conditions = [eq(projectActivityTable.projectId, projectId)];
    if (eventType)
      conditions.push(
        eventType === "build"
          ? inArray(projectActivityTable.eventType, ["build", "build_failed"])
          : eq(projectActivityTable.eventType, eventType),
      );

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
              inArray(agentTasksTable.status, ["completed", "failed"]),
              inArray(
                taskEventsTable.eventType,
                eventType === "build_failed" ? ["failed"] : ["completed", "failed"],
              ),
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
      .filter(
        (event) =>
          eventType === undefined || eventType === "build" || event.eventType === eventType,
      );

    const rows = [...projectRows, ...taskRows]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);

    res.json(rows);
  },
);

export default router;
