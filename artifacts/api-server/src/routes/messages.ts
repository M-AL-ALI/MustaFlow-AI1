import { Router, type IRouter } from "express";
import { asc, and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectFilesTable,
  chatMessagesTable,
  agentTasksTable,
  taskEventsTable,
} from "@workspace/db";
import {
  ListMessagesParams,
  ListMessagesResponse,
  SendMessageParams,
  SendMessageBody,
  SendMessageResponse,
} from "@workspace/api-zod";
import { type AgentMode } from "../lib/ai";
import { runPlanPipeline, runConversePipeline, runIntentClassifierPipeline } from "../lib/builder";
import type { ConversationTurn, ConverseImageAttachment } from "../lib/builder";
import { requireProjectOwnership } from "../lib/auth";
import { enqueueJob, runJob, resolveAgentIdentity, type AgentIdentity } from "../lib/jobs";
import { logger } from "../lib/logger";
import { fetchAttachmentAsDataUri } from "./images";

const router: IRouter = Router();

async function emitPlanEvent(taskId: number, eventType: string, message: string): Promise<void> {
  try {
    await db.insert(taskEventsTable).values({ taskId, eventType, message, filePath: null });
  } catch (err) {
    logger.warn({ err, taskId, eventType }, "Failed to emit plan task event");
  }
}

router.get("/projects/:id/messages", requireProjectOwnership, async (req, res): Promise<void> => {
  const params = ListMessagesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.projectId, params.data.id))
    .orderBy(asc(chatMessagesTable.createdAt));
  res.json(ListMessagesResponse.parse(rows));
});

router.post("/projects/:id/messages", requireProjectOwnership, async (req, res): Promise<void> => {
  const params = SendMessageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = SendMessageBody.safeParse(req.body);
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

  const {
    content,
    agentMode,
    planMode,
    agentIdentity: explicitAgentIdentity,
    agentIntent: explicitAgentIntent,
    attachments: rawAttachments,
  } = parsed.data;
  const mode = agentMode as AgentMode;
  const attachments = Array.isArray(rawAttachments) ? rawAttachments : [];
  const imageAttachments = attachments.filter(
    (a) => a.kind === "image" && typeof a.url === "string",
  );
  // Foreground requests that were queued by aiBuilderLimiter physically wait
  // in-line (HTTP connection held open) until a slot frees, then run here
  // synchronously. Only explicit background=true from the client triggers
  // the async background-job path.
  const runInBackground = Boolean(parsed.data.background);

  // Load current project files — needed for Planning Agent investigation phase
  const currentProjectFiles = await db
    .select({
      path: projectFilesTable.path,
      content: projectFilesTable.content,
      mimeType: projectFilesTable.mimeType,
    })
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, project.id));

  // Load recent conversation history for AI context (last 8 user/assistant turns)
  const recentMessages = await db
    .select({
      role: chatMessagesTable.role,
      content: chatMessagesTable.content,
    })
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.projectId, project.id))
    .orderBy(asc(chatMessagesTable.createdAt));

  const conversationHistory: ConversationTurn[] = recentMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }))
    .slice(-8);

  // Intent detection — resolve the routing intent for this message.
  // Priority: explicit agentIntent override > planMode flag > auto-classifier.
  let resolvedIntent: "converse" | "plan" | "build" = "build";
  let intentConfidence = 1.0;

  if (
    explicitAgentIntent === "converse" ||
    explicitAgentIntent === "plan" ||
    explicitAgentIntent === "build"
  ) {
    // Explicit client override takes highest priority — always honor it,
    // even when the Plan Mode toggle is on (e.g. "Apply to app" must build).
    resolvedIntent = explicitAgentIntent;
  } else if (planMode) {
    resolvedIntent = "plan";
  } else {
    // Run lightweight auto-classifier (gpt-5-nano) to detect intent
    const hasFiles = currentProjectFiles.length > 0;
    try {
      const classified = await runIntentClassifierPipeline(content, conversationHistory, hasFiles);
      resolvedIntent = classified.intent;
      intentConfidence = classified.confidence;
    } catch (err) {
      logger.warn({ err }, "Intent classifier failed, defaulting to build");
      resolvedIntent = hasFiles ? "build" : "converse";
    }
    // Route ALL ambiguous requests to the clarifying pipeline regardless of primary intent.
    // This prevents accidental build/plan runs when the user's meaning is unclear.
    if (intentConfidence < 0.7) {
      resolvedIntent = "converse"; // will be handled with isAmbiguous=true
    }
  }

  // Effective planMode — true when explicitly toggled OR when intent classifier auto-routes to plan.
  // This ensures assistant messages are stored with planMode=true so the plan-card UI renders.
  const effectivePlanMode = planMode || resolvedIntent === "plan";

  // Save user message
  const [userMessage] = await db
    .insert(chatMessagesTable)
    .values({
      projectId: project.id,
      role: "user",
      content,
      agentMode: mode,
      planMode: effectivePlanMode,
      attachments: imageAttachments.length > 0 ? imageAttachments : undefined,
    })
    .returning();
  if (!userMessage) {
    res.status(500).json({ error: "Failed to save message" });
    return;
  }

  let assistantContent: string;
  // eslint-disable-next-line no-useless-assignment
  let plan: Record<string, unknown> | null = null;

  if (resolvedIntent === "converse") {
    // ── Conversational path ─────────────────────────────────────────────────
    // Creates a lightweight task record (kind="converse") for history tracking.
    // No files are written, no build report is generated.
    const isAmbiguous = intentConfidence < 0.7;
    const [converseTask] = await db
      .insert(agentTasksTable)
      .values({
        projectId: project.id,
        title: `Chat: ${content.slice(0, 60)}`,
        kind: "converse",
        status: "building",
        prompt: content,
        agentIdentity: "main",
      })
      .returning();

    const taskId = converseTask?.id ?? 0;

    try {
      const visionParts: ConverseImageAttachment[] = [];
      for (const att of imageAttachments) {
        const dataUri = await fetchAttachmentAsDataUri(att.url);
        if (dataUri) visionParts.push({ dataUri, alt: att.alt });
      }

      const converseResult = await runConversePipeline({
        projectName: project.name,
        userPrompt: content,
        conversationHistory,
        currentFiles: currentProjectFiles,
        agentMode: mode,
        isAmbiguous,
        imageAttachments: visionParts.length > 0 ? visionParts : undefined,
      });

      if (converseTask) {
        await db
          .update(agentTasksTable)
          .set({ status: "completed", result: converseResult.markdown, completedAt: sql`now()` })
          .where(eq(agentTasksTable.id, converseTask.id));
      }

      assistantContent = converseResult.markdown;
      if (converseResult.clarifying) {
        plan = {
          kind: "clarifying",
          question: converseResult.clarifying.question,
          options: converseResult.clarifying.options,
          taskId,
          streaming: true,
        } as unknown as Record<string, unknown>;
      } else {
        plan = { kind: "converse", taskId, streaming: true } as unknown as Record<string, unknown>;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Conversation failed";
      if (converseTask) {
        await db
          .update(agentTasksTable)
          .set({ status: "failed", result: msg, completedAt: sql`now()` })
          .where(eq(agentTasksTable.id, converseTask.id));
      }
      assistantContent = `I wasn't able to answer that: ${msg}`;
      plan = { kind: "error", message: msg } as unknown as Record<string, unknown>;
    }
  } else if (resolvedIntent === "plan") {
    // Create a task row so plan mode is tracked in Build History with live events
    const [planTask] = await db
      .insert(agentTasksTable)
      .values({
        projectId: project.id,
        title: `Plan: ${content.slice(0, 60)}`,
        kind: "plan",
        status: "planning",
        prompt: content,
        agentIdentity: "planning",
      })
      .returning();

    const taskId = planTask?.id ?? 0;

    try {
      await emitPlanEvent(taskId, "queued", "Plan request received…");
      await emitPlanEvent(taskId, "planning", "Analysing project and requirements…");
      await emitPlanEvent(taskId, "generating_blueprint", "Generating structured plan with AI…");

      const result = await runPlanPipeline({
        projectName: project.name,
        projectKind: project.kind,
        userPrompt: content,
        agentMode: mode,
        conversationHistory,
        currentFiles: currentProjectFiles.map((f) => ({
          path: f.path,
          content: f.content,
          mimeType: f.mimeType,
        })),
      });

      const planPageCount = Array.isArray(
        (result.plan as Record<string, unknown> | null)?.["pages"],
      )
        ? ((result.plan as Record<string, unknown>)["pages"] as unknown[]).length
        : 0;
      await emitPlanEvent(
        taskId,
        "completed",
        planPageCount > 0
          ? `Plan ready: ${planPageCount} page(s) outlined.`
          : "Plan ready — review the structured plan above.",
      );

      if (planTask) {
        await db
          .update(agentTasksTable)
          .set({ status: "completed", result: result.summary, completedAt: sql`now()` })
          .where(eq(agentTasksTable.id, planTask.id));
      }

      assistantContent = result.summary;
      plan = result.plan;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Plan generation failed";
      await emitPlanEvent(taskId, "failed", msg);
      if (planTask) {
        await db
          .update(agentTasksTable)
          .set({ status: "failed", result: msg, completedAt: sql`now()` })
          .where(eq(agentTasksTable.id, planTask.id));
      }
      assistantContent = `Plan generation failed: ${msg}`;
      plan = { kind: "error", message: msg };
    }
  } else {
    // Determine if this is an initial build or a refinement
    const [existing] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(sql`(select 1 from project_files where project_id = ${project.id} limit 1) as f`);
    const hasFiles = (existing?.c ?? 0) > 0;
    const kind = hasFiles ? "refine" : "build";

    // Check for an active build/refine — prevent concurrent runs for the same project
    const [activeTask] = await db
      .select({ id: agentTasksTable.id })
      .from(agentTasksTable)
      .where(
        and(
          eq(agentTasksTable.projectId, project.id),
          inArray(agentTasksTable.status, ["building", "planning"]),
        ),
      )
      .limit(1);
    const hasActiveTask = activeTask !== undefined;

    // Create a task row to track the work
    const resolvedAgentIdentity: AgentIdentity =
      (explicitAgentIdentity as AgentIdentity | undefined) ??
      resolveAgentIdentity(content, hasFiles, runInBackground, hasActiveTask, Boolean(planMode));

    const [task] = await db
      .insert(agentTasksTable)
      .values({
        projectId: project.id,
        title:
          kind === "build" ? `Build: ${content.slice(0, 60)}` : `Change: ${content.slice(0, 60)}`,
        kind: runInBackground ? "background" : "main",
        status: hasActiveTask ? "queued" : "planning",
        prompt: content,
        agentIdentity: resolvedAgentIdentity,
      })
      .returning();
    if (!task) {
      res.status(500).json({ error: "Failed to enqueue task" });
      return;
    }

    if (hasActiveTask) {
      assistantContent = `Your request has been queued as Task #${task.id}. It will run automatically when the current build finishes.`;
      plan = { kind: "task-queued", taskId: task.id } as unknown as Record<string, unknown>;
    } else if (runInBackground) {
      enqueueJob({
        taskId: task.id,
        projectId: project.id,
        kind,
        userPrompt: content,
        agentMode: mode,
        agentIdentity: resolvedAgentIdentity,
        conversationHistory,
      });
      assistantContent = `I've queued this in the Background Agent. Task #${task.id} is running and I'll post the report back here when it's done.`;
      plan = { kind: "task-queued", taskId: task.id } as unknown as Record<string, unknown>;
    } else {
      await runJob({
        taskId: task.id,
        projectId: project.id,
        kind,
        userPrompt: content,
        agentMode: mode,
        agentIdentity: resolvedAgentIdentity,
        conversationHistory,
      });
      const [refreshed] = await db
        .select()
        .from(agentTasksTable)
        .where(eq(agentTasksTable.id, task.id));
      assistantContent =
        refreshed?.result ??
        (kind === "build"
          ? "I generated your app. Open the Preview tab to see it."
          : "I applied your changes. Refresh the Preview tab.");
      plan = refreshed?.report
        ? ({ kind: "report", report: refreshed.report, taskId: task.id } as unknown as Record<
            string,
            unknown
          >)
        : ({ kind: "task-done", taskId: task.id } as unknown as Record<string, unknown>);
    }
  }

  const [assistantMessage] = await db
    .insert(chatMessagesTable)
    .values({
      projectId: project.id,
      role: "assistant",
      content: assistantContent,
      agentMode: mode,
      planMode: effectivePlanMode,
      plan: plan ?? undefined,
    })
    .returning();
  if (!assistantMessage) {
    res.status(500).json({ error: "Failed to save assistant message" });
    return;
  }

  await db
    .update(projectsTable)
    .set({
      updatedAt: sql`now()`,
      lastTaskSummary: content.slice(0, 140),
      agentMode: mode,
    })
    .where(eq(projectsTable.id, project.id));

  res.json(
    SendMessageResponse.parse({
      userMessage,
      assistantMessage,
      detectedIntent: resolvedIntent,
    }),
  );
});

export default router;
