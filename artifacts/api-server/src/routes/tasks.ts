import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { db, projectsTable, agentTasksTable } from "@workspace/db";
import {
  ListTasksParams,
  ListTasksResponse,
  CreateTaskParams,
  CreateTaskBody,
  SubmitTaskFeedbackParams,
  SubmitTaskFeedbackBody,
} from "@workspace/api-zod";
import { requireProjectOwnership } from "../lib/auth";
import { enqueueJob } from "../lib/jobs";

const router: IRouter = Router();

router.get("/projects/:id/tasks", requireProjectOwnership, async (req, res): Promise<void> => {
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

router.post("/projects/:id/tasks", requireProjectOwnership, async (req, res): Promise<void> => {
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

  const prompt = parsed.data.prompt ?? parsed.data.title;
  const [task] = await db
    .insert(agentTasksTable)
    .values({
      projectId: project.id,
      title: parsed.data.title,
      kind: parsed.data.kind,
      status: "planning",
      prompt,
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

  const [fileExists] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(sql`(select 1 from project_files where project_id = ${project.id} limit 1) as f`);
  const jobKind = (fileExists?.c ?? 0) > 0 ? "refine" : "build";

  enqueueJob({
    taskId: task.id,
    projectId: project.id,
    kind: jobKind,
    userPrompt: prompt,
    agentMode: project.agentMode as "lite" | "eco" | "power" | "pro",
  });

  res.status(201).json(task);
});

router.patch(
  "/projects/:id/tasks/:taskId/feedback",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const params = SubmitTaskFeedbackParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = SubmitTaskFeedbackBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [task] = await db
      .update(agentTasksTable)
      .set({ userFeedback: parsed.data.feedback })
      .where(eq(agentTasksTable.id, params.data.taskId))
      .returning();
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json(task);
  },
);

export default router;
