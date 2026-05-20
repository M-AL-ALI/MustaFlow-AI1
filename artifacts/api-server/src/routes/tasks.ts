import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, projectsTable, agentTasksTable } from "@workspace/db";
import {
  ListTasksParams,
  ListTasksResponse,
  CreateTaskParams,
  CreateTaskBody,
  SubmitTaskFeedbackParams,
  SubmitTaskFeedbackBody,
  CancelTaskParams,
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

  // Conflict detection: check if any task is currently building or planning for this project.
  // If so, queue the new task instead of launching it immediately.
  const activeTasks = await db
    .select({ id: agentTasksTable.id, status: agentTasksTable.status })
    .from(agentTasksTable)
    .where(
      and(
        eq(agentTasksTable.projectId, project.id),
        inArray(agentTasksTable.status, ["building", "planning"]),
      ),
    )
    .limit(1);

  const hasActiveBuild = activeTasks.length > 0;

  const [task] = await db
    .insert(agentTasksTable)
    .values({
      projectId: project.id,
      title: parsed.data.title,
      kind: parsed.data.kind,
      status: hasActiveBuild ? "queued" : "planning",
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
      status: hasActiveBuild ? project.status : "building",
      lastTaskSummary: parsed.data.title.slice(0, 140),
      updatedAt: sql`now()`,
    })
    .where(eq(projectsTable.id, project.id));

  if (hasActiveBuild) {
    // A build is already in progress — return the task in queued state.
    // The frontend can poll GET /tasks to find out when it eventually runs.
    res.status(201).json({ ...task, queued: true });
    return;
  }

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

  res.status(201).json({ ...task, queued: false });
});

router.post(
  "/projects/:id/tasks/:taskId/cancel",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const params = CancelTaskParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    // Attempt a conditional update: only cancel if the task is still queued.
    const [task] = await db
      .update(agentTasksTable)
      .set({ status: "canceled", completedAt: sql`now()` })
      .where(
        and(
          eq(agentTasksTable.id, params.data.taskId),
          eq(agentTasksTable.projectId, params.data.id),
          eq(agentTasksTable.status, "queued"),
        ),
      )
      .returning();

    if (!task) {
      // Either the task doesn't exist or it's already past "queued" state.
      const [existing] = await db
        .select({ id: agentTasksTable.id, status: agentTasksTable.status })
        .from(agentTasksTable)
        .where(
          and(
            eq(agentTasksTable.id, params.data.taskId),
            eq(agentTasksTable.projectId, params.data.id),
          ),
        )
        .limit(1);

      if (!existing) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      res
        .status(409)
        .json({ error: `Task is already in state "${existing.status}" and cannot be canceled` });
      return;
    }

    res.json(task);
  },
);

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
