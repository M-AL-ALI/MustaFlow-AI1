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
  ApplyTaskStagingParams,
  DiscardTaskStagingParams,
  RerunTaskTestsParams,
  UpdateTaskBody,
  UpdateTaskParams,
} from "@workspace/api-zod";
import { requireProjectOwnership } from "../lib/auth";
import {
  enqueueJob,
  applyTaskAgentStaging,
  discardTaskAgentStaging,
  runAppTestingJob,
  cancelActiveJob,
} from "../lib/jobs";

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

  const rowsWithElapsed = rows.map((row) => ({
    ...row,
    elapsedSeconds:
      row.completedAt && (row.startedAt ?? row.createdAt)
        ? Math.round(
            (row.completedAt.getTime() - (row.startedAt ?? row.createdAt).getTime()) / 1000,
          )
        : null,
  }));

  res.json(ListTasksResponse.parse(rowsWithElapsed));
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

    // For building/planning tasks, abort the in-flight AI call first so the
    // pipeline can clean up gracefully, then fall through to the DB update.
    cancelActiveJob(params.data.taskId);

    // Attempt a conditional update: cancel if the task is queued, building, or planning.
    const [task] = await db
      .update(agentTasksTable)
      .set({ status: "canceled", completedAt: sql`now()` })
      .where(
        and(
          eq(agentTasksTable.id, params.data.taskId),
          eq(agentTasksTable.projectId, params.data.id),
          inArray(agentTasksTable.status, ["queued", "building", "planning"]),
        ),
      )
      .returning();

    if (!task) {
      // Either the task doesn't exist or it's already in a terminal state.
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

router.post(
  "/projects/:id/tasks/:taskId/apply",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const params = ApplyTaskStagingParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    try {
      await applyTaskAgentStaging(params.data.taskId, params.data.id);
      const [task] = await db
        .select()
        .from(agentTasksTable)
        .where(eq(agentTasksTable.id, params.data.taskId))
        .limit(1);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      res.json(task);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Apply failed";
      req.log.error({ err, taskId: params.data.taskId }, "Apply task staging failed");
      if (message.includes("not found")) {
        res.status(404).json({ error: message });
        return;
      }
      if (message.includes("not needs_review")) {
        res.status(409).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
    }
  },
);

router.post(
  "/projects/:id/tasks/:taskId/discard",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const params = DiscardTaskStagingParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    try {
      await discardTaskAgentStaging(params.data.taskId, params.data.id);
      const [task] = await db
        .select()
        .from(agentTasksTable)
        .where(eq(agentTasksTable.id, params.data.taskId))
        .limit(1);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      res.json(task);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Discard failed";
      req.log.error({ err, taskId: params.data.taskId }, "Discard task staging failed");
      if (message.includes("not found")) {
        res.status(404).json({ error: message });
        return;
      }
      if (message.includes("not needs_review")) {
        res.status(409).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
    }
  },
);

router.patch(
  "/projects/:id/tasks/:taskId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const params = UpdateTaskParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateTaskBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [existing] = await db
      .select()
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

    // Merge testScript into the existing report, preserving all existing fields
    const baseReport = existing.report ?? {
      userRequest: "",
      filesCreated: [],
      filesChanged: [],
      filesRemoved: [],
      previewUpdated: false,
      warnings: [],
      integrationsNeeded: [],
    };
    const updatedReport = {
      ...baseReport,
      testScript: parsed.data.testScript ?? null,
    };

    const [task] = await db
      .update(agentTasksTable)
      .set({ report: updatedReport })
      .where(eq(agentTasksTable.id, params.data.taskId))
      .returning();

    if (!task) {
      res.status(500).json({ error: "Failed to update task" });
      return;
    }

    res.json(task);
  },
);

router.post(
  "/projects/:id/tasks/:taskId/rerun-tests",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const params = RerunTaskTestsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [task] = await db
      .select()
      .from(agentTasksTable)
      .where(
        and(
          eq(agentTasksTable.id, params.data.taskId),
          eq(agentTasksTable.projectId, params.data.id),
        ),
      )
      .limit(1);

    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const [project] = await db
      .select({ name: projectsTable.name, kind: projectsTable.kind })
      .from(projectsTable)
      .where(eq(projectsTable.id, params.data.id))
      .limit(1);

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    // Pass the saved testScript (if any) so custom plans are used instead of AI re-generation
    const savedTestScript = task.report?.testScript ?? null;

    // Kick off tests in the background
    setImmediate(() => {
      void runAppTestingJob(
        params.data.id,
        params.data.taskId,
        project.name ?? project.kind,
        savedTestScript,
      ).catch((err) => req.log.warn({ err, taskId: params.data.taskId }, "Rerun tests failed"));
    });

    res.json({ queued: true, taskId: params.data.taskId, projectId: params.data.id });
  },
);

export default router;
