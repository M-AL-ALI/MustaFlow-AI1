import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { db, projectsTable, agentTasksTable } from "@workspace/db";
import {
  ListTasksParams,
  ListTasksResponse,
  CreateTaskParams,
  CreateTaskBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/projects/:id/tasks", async (req, res): Promise<void> => {
  const params = ListTasksParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(agentTasksTable)
    .where(eq(agentTasksTable.projectId, params.data.id))
    .orderBy(desc(agentTasksTable.createdAt));
  res.json(ListTasksResponse.parse(rows));
});

router.post("/projects/:id/tasks", async (req, res): Promise<void> => {
  const params = CreateTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, params.data.id));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [task] = await db
    .insert(agentTasksTable)
    .values({
      projectId: project.id,
      title: parsed.data.title,
      kind: parsed.data.kind,
      status: parsed.data.kind === "background" ? "queued" : "planning",
    })
    .returning();

  if (!task) {
    res.status(500).json({ error: "Failed to create task" });
    return;
  }

  await db
    .update(projectsTable)
    .set({
      status: "building",
      lastTaskSummary: parsed.data.title.slice(0, 140),
      updatedAt: sql`now()`,
    })
    .where(eq(projectsTable.id, project.id));

  // Simulate task progression so the UI sees movement (no real build engine yet).
  setTimeout(() => {
    void db
      .update(agentTasksTable)
      .set({
        status: "completed",
        completedAt: sql`now()`,
        result:
          "Task acknowledged. The live build engine is not yet wired up; this task was simulated for the preview shell.",
      })
      .where(eq(agentTasksTable.id, task.id));
  }, 4000);

  res.status(201).json(task);
});

export default router;
