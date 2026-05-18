import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import { db, agentTasksTable, taskEventsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";

const router: IRouter = Router();

router.get(
  "/projects/:id/tasks/:taskId/events",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const taskId = Number(req.params.taskId);
    if (!Number.isFinite(projectId) || !Number.isFinite(taskId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    // Verify the task belongs to this project
    const [task] = await db
      .select({ id: agentTasksTable.id, status: agentTasksTable.status })
      .from(agentTasksTable)
      .where(eq(agentTasksTable.id, taskId));

    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const events = await db
      .select()
      .from(taskEventsTable)
      .where(eq(taskEventsTable.taskId, taskId))
      .orderBy(asc(taskEventsTable.createdAt));

    res.json(
      events.map((e) => ({
        id: e.id,
        taskId: e.taskId,
        eventType: e.eventType,
        message: e.message,
        filePath: e.filePath ?? null,
        createdAt: e.createdAt,
      })),
    );
  },
);

export default router;
