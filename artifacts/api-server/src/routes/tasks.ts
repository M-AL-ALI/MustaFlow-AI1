import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db, projectsTable, agentTasksTable, chatMessagesTable } from "@workspace/db";
import {
  ListTasksParams,
  ListTasksResponse,
  CreateTaskParams,
  CreateTaskBody,
  ReorderTasksBody,
  ReorderTasksParams,
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
import { taskCreditSettlementKey } from "../lib/billing-settlement-outbox";
import { projectSummaryProvenance } from "../lib/project-summary-provenance";
import { governIntentAdmission } from "../lib/zero-intent-admission";
import { persistInterruptedZeroTerminal } from "../lib/zero-terminal-persistence";

const router: IRouter = Router();

router.get("/projects/:id/tasks", requireProjectOwnership, async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
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

  // Filter out legacy task kinds (e.g. "refine") that no longer exist in the
  // current API enum. Passing unknown kinds to ListTasksResponse.parse() throws
  // a ZodError and returns a 500. Legacy rows are safe to omit from the list
  // because they are historical-only and the UI doesn't need them.
  const VALID_KINDS = new Set(["main", "background", "plan", "converse"]);
  const rowsWithElapsed = rows
    .filter((row) => VALID_KINDS.has(row.kind))
    .map((row) => ({
      ...row,
      elapsedSeconds:
        row.completedAt && (row.startedAt ?? row.createdAt)
          ? Math.round(
              (row.completedAt.getTime() - (row.startedAt ?? row.createdAt).getTime()) / 1000,
            )
          : null,
    }));

  // Use safeParse so a schema mismatch in any field (e.g. stagingSnapshot stored
  // as an array instead of object) never causes a 500 — just return the raw rows.
  const parsed = ListTasksResponse.safeParse(rowsWithElapsed);
  res.json(
    parsed.success
      ? parsed.data.map((row, index) => {
          const terminal = rowsWithElapsed[index]?.terminal;
          return terminal === null || terminal === undefined ? row : { ...row, terminal };
        })
      : rowsWithElapsed,
  );
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

  // NabuFlow billing gate (Task #1516): tasks execute builds, so they pass
  // the same server-side resolver as every other build entry point.
  if (project.ownerId) {
    const { creditCostFor, resolveStageProvider } = await import("../lib/ai-providers");
    const gateMode = project.agentMode as Parameters<typeof creditCostFor>[0];
    const { provider } = resolveStageProvider("build", gateMode);
    const { nabuflowGateHttpError } = await import("../lib/nabuflow-billing");
    const gateErr = await nabuflowGateHttpError(project.ownerId, {
      engineMode: gateMode,
      deepReasoning: false,
      projectedCredits: creditCostFor(gateMode, provider, false),
      source: "pipeline",
    });
    if (gateErr) {
      res.status(gateErr.status).json(gateErr.body);
      return;
    }
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
        inArray(agentTasksTable.status, ["building", "planning", "needs_review", "needs_fix"]),
        ne(agentTasksTable.kind, "background"),
      ),
    )
    .limit(1);

  const hasActiveBuild = activeTasks.length > 0;

  // If chatContent is provided and a build is active, insert a user chat message first
  // so the queued task shows up immediately in the chat feed.
  if (hasActiveBuild && parsed.data.chatContent) {
    await db.insert(chatMessagesTable).values({
      projectId: project.id,
      role: "user",
      content: parsed.data.chatContent,
      agentMode: project.agentMode,
      planMode: false,
    });
  }

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
  const admission = await governIntentAdmission({
    phase: "creator",
    projectId: project.id,
    taskId: task.id,
    requestId: `system:task-create:${task.id}`,
    mutationCapable: true,
    source: "system_action",
  });

  await db
    .update(projectsTable)
    .set({
      status: hasActiveBuild ? project.status : "building",
      lastTaskSummary: parsed.data.title.slice(0, 140),
      lastTaskSummaryProvenance: projectSummaryProvenance({
        sourceKind: "task",
        sourceIdentity: `task:${task.id}`,
        taskId: task.id,
        actorUserId: req.userId,
        content: parsed.data.title.slice(0, 140),
      }),
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
    intentReceiptId: admission.receiptId,
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

    const [pre] = await db
      .select()
      .from(agentTasksTable)
      .where(
        and(
          eq(agentTasksTable.id, params.data.taskId),
          eq(agentTasksTable.projectId, params.data.id),
        ),
      )
      .limit(1);
    if (!pre) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (!["queued", "building", "planning"].includes(pre.status)) {
      res
        .status(409)
        .json({ error: `Task is already in state "${pre.status}" and cannot be canceled` });
      return;
    }
    if (!Number.isInteger(pre.intentReceiptId) || (pre.intentReceiptId ?? 0) < 1) {
      res.status(409).json({ error: "This older task cannot be canceled safely." });
      return;
    }

    cancelActiveJob(pre.id);
    const { persisted } = await persistInterruptedZeroTerminal({
      taskId: pre.id,
      intent: pre.kind === "plan" ? "plan" : "mutate",
      intentReceiptId: pre.intentReceiptId!,
      cause: "user_stop",
      evidence: { lastPhase: pre.status === "queued" ? null : pre.status, changedPaths: [] },
      allowedStatuses: ["queued", "building", "planning"],
      taskUpdate: { creditsReserved: null },
    });
    const [task] = await db
      .select()
      .from(agentTasksTable)
      .where(eq(agentTasksTable.id, pre.id))
      .limit(1);
    if (!persisted && task?.terminal?.outcome !== "interrupted") {
      res.status(409).json({
        error: `Task is already in state "${task?.status ?? "unknown"}" and cannot be canceled`,
      });
      return;
    }

    // Refund the captured pre-update amount (Task #509 — background jobs).
    if (task && (pre.creditsReserved ?? 0) > 0) {
      const [proj] = await db
        .select({ ownerId: projectsTable.ownerId })
        .from(projectsTable)
        .where(eq(projectsTable.id, params.data.id))
        .limit(1);
      if (proj?.ownerId) {
        void refundCredits(proj.ownerId, pre.creditsReserved ?? 0, {
          projectId: params.data.id,
          taskId: task.id,
          settlementKey: taskCreditSettlementKey(task.id, "pipeline"),
          description: `Background task #${task.id} canceled`,
        }).catch((err) => logger.warn({ err, taskId: task.id }, "Credit refund failed"));
      }
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

    // Cancel any currently active executable tasks for this project. Review/fix
    // gates are user decisions and should be resolved from their own controls.
    const activeTasks = await db
      .select({
        id: agentTasksTable.id,
        kind: agentTasksTable.kind,
        status: agentTasksTable.status,
        intentReceiptId: agentTasksTable.intentReceiptId,
      })
      .from(agentTasksTable)
      .where(
        and(
          eq(agentTasksTable.projectId, projectId),
          inArray(agentTasksTable.status, ["building", "planning"]),
        ),
      );

    if (activeTasks.some((active) => !Number.isInteger(active.intentReceiptId))) {
      res.status(409).json({ error: "An older active task cannot be interrupted safely." });
      return;
    }
    for (const active of activeTasks) {
      cancelActiveJob(active.id);
      await persistInterruptedZeroTerminal({
        taskId: active.id,
        intent: active.kind === "plan" ? "plan" : "mutate",
        intentReceiptId: active.intentReceiptId!,
        cause: "superseded",
        evidence: { lastPhase: active.status, changedPaths: [] },
        allowedStatuses: ["building", "planning"],
      });
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

router.post(
  "/projects/:id/tasks/reorder",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const params = ReorderTasksParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = ReorderTasksBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { id: projectId } = params.data;
    const { taskIds } = parsed.data;

    if (taskIds.length === 0) {
      res.json([]);
      return;
    }

    // In a single transaction: validate all IDs belong to this project and are queued,
    // then set queueIndex to each task's position in the provided array.
    const updated = await db.transaction(async (tx) => {
      const existingTasks = await tx
        .select({ id: agentTasksTable.id, status: agentTasksTable.status })
        .from(agentTasksTable)
        .where(and(eq(agentTasksTable.projectId, projectId), inArray(agentTasksTable.id, taskIds)));

      const existingIds = new Set(existingTasks.map((t) => t.id));
      const nonQueued = existingTasks.filter((t) => t.status !== "queued");

      if (existingIds.size !== taskIds.length) {
        return { error: "One or more task IDs not found in this project" };
      }
      if (nonQueued.length > 0) {
        return { error: "Only queued tasks can be reordered" };
      }

      const results: (typeof agentTasksTable.$inferSelect)[] = [];
      for (let i = 0; i < taskIds.length; i++) {
        const [row] = await tx
          .update(agentTasksTable)
          .set({ queueIndex: i })
          .where(eq(agentTasksTable.id, taskIds[i]!))
          .returning();
        if (row) results.push(row);
      }
      return { tasks: results };
    });

    if ("error" in updated) {
      res.status(400).json({ error: updated.error });
      return;
    }

    res.json(updated.tasks);
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
    const { durableEnqueueRawResult, isDurableWorkerReady, QUEUE_APP_TESTING } =
      await import("../lib/durable-queue");
    let enqueued = false;
    if (isDurableWorkerReady(QUEUE_APP_TESTING)) {
      const outcome = await durableEnqueueRawResult(
        QUEUE_APP_TESTING,
        {
          projectId: params.data.id,
          taskId: params.data.taskId,
          projectDescription: project.name ?? project.kind,
          savedTestScript: savedTestScript ?? null,
        },
        undefined,
        { retryLimit: 2, retryDelay: 15, retryBackoff: true },
      );
      // Rerun is an intentional repeat action; it must not carry a permanent
      // task-level singleton key that would suppress later user requests.
      enqueued = outcome.status === "enqueued";
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
