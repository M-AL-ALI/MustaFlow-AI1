import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db, projectsTable, agentTasksTable } from "@workspace/db";
import {
  ListTasksParams,
  ListTasksResponse,
  CreateTaskParams,
  CreateTaskBody,
  SubmitTaskFeedbackParams,
  SubmitTaskFeedbackBody,
  CancelTaskParams,
  ForceStartTaskParams,
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
  drainNextProjectTask,
} from "../lib/jobs";
import { refundCredits } from "./credits";
import { logger } from "../lib/logger";

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

  // Conflict detection: check if any non-background task is currently building or planning for
  // this project. Background tasks (provisioning, blueprint npm-install, etc.) must not block
  // the user from submitting new tasks.
  const activeTasks = await db
    .select({ id: agentTasksTable.id, status: agentTasksTable.status })
    .from(agentTasksTable)
    .where(
      and(
        eq(agentTasksTable.projectId, project.id),
        inArray(agentTasksTable.status, ["building", "planning"]),
        ne(agentTasksTable.kind, "background"),
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
      taskAgentMode: project.agentMode,
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
    // IMPORTANT: capture the pre-update reserved-credits amount in the SAME UPDATE
    // via `returning()` (the returned row reflects values BEFORE we set them in this
    // statement is FALSE — Postgres returns the post-update row). So we must read it
    // first under a transaction. Use a transaction with SELECT + UPDATE to avoid the
    // ordering bug where setting creditsReserved=null erases the refund amount.
    const cancelResult = await db.transaction(async (tx) => {
      const [pre] = await tx
        .select({
          id: agentTasksTable.id,
          status: agentTasksTable.status,
          creditsReserved: agentTasksTable.creditsReserved,
        })
        .from(agentTasksTable)
        .where(
          and(
            eq(agentTasksTable.id, params.data.taskId),
            eq(agentTasksTable.projectId, params.data.id),
          ),
        )
        .limit(1);

      if (!pre) return { task: null, reserved: 0 };
      if (!["queued", "building", "planning"].includes(pre.status)) {
        return { task: pre, reserved: 0, alreadyTerminal: true };
      }

      const [updated] = await tx
        .update(agentTasksTable)
        .set({ status: "canceled", completedAt: sql`now()`, creditsReserved: null })
        .where(eq(agentTasksTable.id, pre.id))
        .returning();

      return { task: updated ?? pre, reserved: pre.creditsReserved ?? 0 };
    });

    const task = cancelResult.task && !cancelResult.alreadyTerminal ? cancelResult.task : null;

    // Refund the captured pre-update amount (Task #509 — background jobs).
    if (task && cancelResult.reserved > 0) {
      const [proj] = await db
        .select({ ownerId: projectsTable.ownerId })
        .from(projectsTable)
        .where(eq(projectsTable.id, params.data.id))
        .limit(1);
      if (proj?.ownerId) {
        void refundCredits(proj.ownerId, cancelResult.reserved, {
          projectId: params.data.id,
          description: `Background task #${task.id} canceled`,
        }).catch((err) => logger.warn({ err, taskId: task.id }, "Credit refund failed"));
      }
    }

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

router.post(
  "/projects/:id/tasks/:taskId/force-start",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const params = ForceStartTaskParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { id: projectId, taskId } = params.data;

    // Verify the task exists, belongs to this project, and is actually queued.
    const [target] = await db
      .select()
      .from(agentTasksTable)
      .where(and(eq(agentTasksTable.id, taskId), eq(agentTasksTable.projectId, projectId)))
      .limit(1);

    if (!target) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (target.status !== "queued") {
      res.status(409).json({
        error: `Task is in state "${target.status}" — only queued tasks can be force-started`,
      });
      return;
    }

    // Cancel any currently active (building/planning) tasks for this project.
    const activeTasks = await db
      .select({ id: agentTasksTable.id })
      .from(agentTasksTable)
      .where(
        and(
          eq(agentTasksTable.projectId, projectId),
          inArray(agentTasksTable.status, ["building", "planning"]),
        ),
      );

    for (const active of activeTasks) {
      cancelActiveJob(active.id);
      await db
        .update(agentTasksTable)
        .set({ status: "canceled", completedAt: sql`now()` })
        .where(
          and(
            eq(agentTasksTable.id, active.id),
            inArray(agentTasksTable.status, ["building", "planning"]),
          ),
        );
      logger.info({ activeTaskId: active.id, projectId }, "Force-start: cancelled active task");
    }

    // Drain the project queue — preferring the specific task the user requested
    // (without this hint, the drain would pick the oldest queued task instead).
    await drainNextProjectTask(projectId, taskId);

    // Return the (now-enqueued) task row.
    const [updated] = await db
      .select()
      .from(agentTasksTable)
      .where(eq(agentTasksTable.id, taskId))
      .limit(1);

    res.json(updated ?? target);
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
      if (message.includes("not needs_review") || message.includes("expected needs_review")) {
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
      if (message.includes("not needs_review") || message.includes("expected needs_review")) {
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
  "/projects/:id/tasks/:taskId/steer",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const taskId = Number(req.params.taskId);
    if (!Number.isFinite(projectId) || !Number.isFinite(taskId)) {
      res.status(400).json({ error: "Invalid params" });
      return;
    }
    const hint = typeof req.body?.hint === "string" ? req.body.hint.trim() : "";
    if (!hint) {
      res.status(400).json({ error: "hint is required" });
      return;
    }
    if (hint.length > 2000) {
      res.status(400).json({ error: "hint too long (max 2000 chars)" });
      return;
    }

    const [task] = await db
      .select({ id: agentTasksTable.id, status: agentTasksTable.status })
      .from(agentTasksTable)
      .where(and(eq(agentTasksTable.id, taskId), eq(agentTasksTable.projectId, projectId)))
      .limit(1);

    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (task.status !== "running") {
      res.status(409).json({ error: "Task is not currently running" });
      return;
    }

    const { setSteeringHint } = await import("../lib/steering-hints");
    await setSteeringHint(taskId, hint);
    req.log.info({ projectId, taskId, hintLen: hint.length }, "steering hint queued");
    res.json({ ok: true });
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

    // Kick off tests via the durable queue (survives server restarts); fall back
    // to in-memory setImmediate when the queue is unavailable.
    const { durableEnqueueRaw, isDurableQueueReady, QUEUE_APP_TESTING } =
      await import("../lib/durable-queue");
    const key = `testing-${params.data.taskId}`;
    let enqueued = false;
    if (isDurableQueueReady()) {
      const jobId = await durableEnqueueRaw(
        QUEUE_APP_TESTING,
        {
          projectId: params.data.id,
          taskId: params.data.taskId,
          projectDescription: project.name ?? project.kind,
          savedTestScript: savedTestScript ?? null,
        },
        key,
        { retryLimit: 2, retryDelay: 15, retryBackoff: true },
      );
      enqueued = jobId !== null;
    }
    if (!enqueued) {
      setImmediate(() => {
        void runAppTestingJob(
          params.data.id,
          params.data.taskId,
          project.name ?? project.kind,
          savedTestScript,
        ).catch((err) => req.log.warn({ err, taskId: params.data.taskId }, "Rerun tests failed"));
      });
    }

    res.json({ queued: true, taskId: params.data.taskId, projectId: params.data.id });
  },
);

router.post(
  "/projects/:id/tasks/:taskId/explain-change",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const taskId = Number(req.params.taskId);
    if (!Number.isFinite(projectId) || !Number.isFinite(taskId)) {
      res.status(400).json({ error: "Invalid params" });
      return;
    }

    const { path, before, after } = req.body ?? {};
    if (typeof path !== "string" || path.trim().length === 0) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    if (typeof before !== "string" || typeof after !== "string") {
      res.status(400).json({ error: "before and after are required strings" });
      return;
    }

    const [task] = await db
      .select({ id: agentTasksTable.id, status: agentTasksTable.status })
      .from(agentTasksTable)
      .where(and(eq(agentTasksTable.id, taskId), eq(agentTasksTable.projectId, projectId)))
      .limit(1);

    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    // Build a concise unified diff for the prompt (cap to ~120 lines for speed).
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    const isNew = before.trim().length === 0;
    const isDeleted = after.trim().length === 0;

    let diffPreview: string;
    if (isNew) {
      diffPreview = afterLines
        .slice(0, 60)
        .map((l) => `+ ${l}`)
        .join("\n");
    } else if (isDeleted) {
      diffPreview = beforeLines
        .slice(0, 60)
        .map((l) => `- ${l}`)
        .join("\n");
    } else {
      const added = afterLines.filter((l, i) => l !== (beforeLines[i] ?? "")).slice(0, 40);
      const removed = beforeLines.filter((l, i) => l !== (afterLines[i] ?? "")).slice(0, 40);
      diffPreview = [
        ...removed.slice(0, 20).map((l) => `- ${l}`),
        ...added.slice(0, 20).map((l) => `+ ${l}`),
      ].join("\n");
    }

    try {
      const { openai } = await import("@workspace/integrations-openai-ai-server");
      // Stream the explanation so the UI can render tokens incrementally.
      const stream = await openai.chat.completions.create({
        model: "gpt-5-mini",
        max_completion_tokens: 120,
        stream: true,
        messages: [
          {
            role: "system",
            content:
              "You are a code reviewer. Summarise the given file change in exactly ONE sentence of plain English (no jargon, no file path, no markdown). Describe what changed and, if obvious from context, why. Be specific but concise.",
          },
          {
            role: "user",
            content: `File: ${path}\n\n${diffPreview.slice(0, 3000)}`,
          },
        ],
      });

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("X-Accel-Buffering", "no"); // disable nginx/proxy buffering
      res.flushHeaders();

      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content ?? "";
        if (text) res.write(text);
      }
      res.end();
    } catch (err) {
      req.log.warn({ err, taskId, path }, "explain-change AI call failed");
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to generate explanation" });
      } else {
        res.end();
      }
    }
  },
);

export default router;
