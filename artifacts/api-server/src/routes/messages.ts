import { Router, type IRouter } from "express";
import { asc, and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectFilesTable,
  chatMessagesTable,
  agentTasksTable,
  taskEventsTable,
  knowledgeEntriesTable,
} from "@workspace/db";
import {
  ListMessagesParams,
  ListMessagesResponse,
  SendMessageParams,
  SendMessageBody,
  SendMessageResponse,
} from "@workspace/api-zod";
import { type AgentMode } from "../lib/ai";
import {
  runPlanPipeline,
  runConversePipeline,
  runConversationSummarizePipeline,
  runConverseStreamPipeline,
  runIntentClassifierPipeline,
} from "../lib/builder";
import type { ConversationTurn, ConverseImageAttachment } from "../lib/builder";
import { requireProjectOwnership } from "../lib/auth";
import {
  enqueueJob,
  runJob,
  resolveAgentIdentity,
  type AgentIdentity,
  CREDIT_COST,
  backgroundWallClockFor,
} from "../lib/jobs";
import { deductCreditsAtomic, getOrCreateCredits, CREDITS_ENFORCEMENT_ENABLED } from "./credits";
import { logger } from "../lib/logger";
import { writeKnowledge } from "../lib/knowledge";
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
    agentMode,
    planMode,
    agentIdentity: explicitAgentIdentity,
    agentIntent: explicitAgentIntent,
    attachments: rawAttachments,
    origin,
  } = parsed.data;
  let { content } = parsed.data;
  const mode = agentMode as AgentMode;
  const attachments = Array.isArray(rawAttachments) ? rawAttachments : [];
  const imageAttachments = attachments.filter(
    (a) => a.kind === "image" && typeof a.url === "string",
  );

  // Screenshot-to-code: if an image is attached with no meaningful text prompt,
  // inject a sensible default so the build pipeline knows what to do.
  const SCREENSHOT_DEFAULT_PROMPT =
    "Replicate this UI as a React + Tailwind component, matching the layout, colours, spacing, and typography exactly.";
  if (imageAttachments.length > 0 && content.trim().length < 10) {
    content = SCREENSHOT_DEFAULT_PROMPT + (content.trim() ? " " + content.trim() : "");
  }
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
  // Also load the most recent conversation summary for long-range context injection.
  const [recentMessages, summaryEntry] = await Promise.all([
    db
      .select({
        role: chatMessagesTable.role,
        content: chatMessagesTable.content,
      })
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.projectId, project.id))
      .orderBy(asc(chatMessagesTable.createdAt)),
    db
      .select({ content: knowledgeEntriesTable.content })
      .from(knowledgeEntriesTable)
      .where(
        and(
          eq(knowledgeEntriesTable.projectId, project.id),
          eq(knowledgeEntriesTable.type, "conversation_summary"),
        ),
      )
      .orderBy(desc(knowledgeEntriesTable.createdAt))
      .limit(1),
  ]);

  const conversationSummary = summaryEntry[0]?.content;

  const conversationHistory: ConversationTurn[] = recentMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }))
    .slice(-8);

  // Intent detection — resolve the routing intent for this message.
  // Priority: image attachments (always build) > explicit agentIntent override > planMode > classifier.
  type ResolvedIntent = "converse" | "plan" | "build" | "debug" | "refactor" | "review" | "explain";
  let resolvedIntent: ResolvedIntent = "build";
  let intentConfidence = 1.0;

  if (imageAttachments.length > 0) {
    // Screenshot-to-code: image attachments unconditionally route to build/refine —
    // skip classifier AND ignore any explicit intent/planMode from the client so the
    // vision model always runs (plan/converse don't support image inputs).
    resolvedIntent = "build";
    intentConfidence = 1.0;
  } else if (
    explicitAgentIntent === "converse" ||
    explicitAgentIntent === "plan" ||
    explicitAgentIntent === "build" ||
    explicitAgentIntent === "debug" ||
    explicitAgentIntent === "refactor" ||
    explicitAgentIntent === "review" ||
    explicitAgentIntent === "explain"
  ) {
    // Explicit client override takes second priority — always honor it,
    // even when the Plan Mode toggle is on (e.g. "Apply to app" must build).
    resolvedIntent = explicitAgentIntent as ResolvedIntent;
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
  const messageOrigin = typeof origin === "string" && origin.length > 0 ? origin : null;
  const [userMessage] = await db
    .insert(chatMessagesTable)
    .values({
      projectId: project.id,
      role: "user",
      content,
      agentMode: mode,
      planMode: effectivePlanMode,
      attachments: imageAttachments.length > 0 ? imageAttachments : undefined,
      origin: messageOrigin,
    })
    .returning();
  if (!userMessage) {
    res.status(500).json({ error: "Failed to save message" });
    return;
  }

  let assistantContent: string;
  // eslint-disable-next-line no-useless-assignment
  let plan: Record<string, unknown> | null = null;

  const DEVELOPER_INTENT_SYSTEM_PROMPTS: Record<string, string> = {
    debug: (await import("../lib/builder")).DEBUG_SYSTEM_PROMPT,
    refactor: (await import("../lib/builder")).REFACTOR_SYSTEM_PROMPT,
    review: (await import("../lib/builder")).REVIEW_SYSTEM_PROMPT,
    explain: (await import("../lib/builder")).EXPLAIN_SYSTEM_PROMPT,
  };

  if (
    resolvedIntent === "converse" ||
    resolvedIntent === "debug" ||
    resolvedIntent === "refactor" ||
    resolvedIntent === "review" ||
    resolvedIntent === "explain"
  ) {
    // ── Conversational / developer-intent path ───────────────────────────────
    // Creates a lightweight task record (kind="converse") for history tracking.
    // No files are written, no build report is generated.

    // Deduct 1 credit for all converse-family intents (converse, debug, refactor, review, explain).
    const converseOwner = req.userId ?? project.ownerId;
    if (converseOwner) {
      const deduction = await deductCreditsAtomic(converseOwner, 1, {
        type: "converse",
        description: `${resolvedIntent !== "converse" ? resolvedIntent.charAt(0).toUpperCase() + resolvedIntent.slice(1) : "Assistant chat"} — project ${project.id}`,
        projectId: project.id,
      });
      if ("insufficient" in deduction) {
        res.status(402).json({
          error: "Insufficient credits. Top up in Billing to continue.",
        });
        return;
      }
    }

    const isAmbiguous = resolvedIntent === "converse" && intentConfidence < 0.7;
    const systemPromptOverride =
      resolvedIntent !== "converse" ? DEVELOPER_INTENT_SYSTEM_PROMPTS[resolvedIntent] : undefined;
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
        conversationSummary,
        systemPromptOverride,
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
        plan = {
          kind: "converse",
          taskId,
          intent: resolvedIntent !== "converse" ? resolvedIntent : undefined,
          streaming: true,
        } as unknown as Record<string, unknown>;
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
        conversationSummary,
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

    // Check for an active build/refine — prevent concurrent runs for the same project.
    // needs_review is included so a queued Task Agent staging that hasn't been
    // applied/discarded yet blocks new runs (Task #509 review-gate serialization).
    // Background tasks (provisioning, blueprint npm-install, etc.) are excluded so
    // they do not block user-initiated runs.
    const [activeTask] = await db
      .select({ id: agentTasksTable.id })
      .from(agentTasksTable)
      .where(
        and(
          eq(agentTasksTable.projectId, project.id),
          inArray(agentTasksTable.status, ["building", "planning", "needs_review"]),
          ne(agentTasksTable.kind, "background"),
        ),
      )
      .limit(1);
    const hasActiveTask = activeTask !== undefined;

    // Create a task row to track the work
    const resolvedAgentIdentity: AgentIdentity =
      (explicitAgentIdentity as AgentIdentity | undefined) ??
      resolveAgentIdentity(content, hasFiles, runInBackground, hasActiveTask, Boolean(planMode));

    // Per-mode wall-clock cap for background runs (Task #509).
    const wallClockCapMs = runInBackground ? backgroundWallClockFor(mode) : null;

    // Reserve credits upfront for background runs. Foreground runs deduct on success.
    // If the user can't afford it, refuse before creating the task row.
    let reservedCredits: number | null = null;
    if (runInBackground && project.ownerId) {
      // Provider-aware reservation: charge what the actual stage routing will
      // bill so background runs match foreground deductions (Task #533).
      const { resolveStageProvider, creditCostFor } = await import("../lib/ai-providers");
      const { provider: resolvedProvider } = resolveStageProvider(
        kind === "build" ? "build" : "refine",
        mode as Parameters<typeof creditCostFor>[0],
      );
      const cost = creditCostFor(mode as Parameters<typeof creditCostFor>[0], resolvedProvider);
      const credits = await getOrCreateCredits(project.ownerId);
      if (CREDITS_ENFORCEMENT_ENABLED && credits.balance < cost) {
        res.status(402).json({
          error: `Insufficient credits. A background ${mode} run reserves ${cost} credit(s) but your balance is ${credits.balance}. Top up in Billing.`,
        });
        return;
      }
      const deduct = await deductCreditsAtomic(project.ownerId, cost, {
        type: kind === "build" ? "build" : "refine",
        description: `Reserve for background task — project ${project.id} (${mode})`,
        projectId: project.id,
      });
      if ("insufficient" in deduct) {
        res.status(402).json({ error: "Insufficient credits to reserve background run." });
        return;
      }
      reservedCredits = cost;
    }

    const [task] = await db
      .insert(agentTasksTable)
      .values({
        projectId: project.id,
        title:
          kind === "build" ? `Build: ${content.slice(0, 60)}` : `Change: ${content.slice(0, 60)}`,
        kind: runInBackground ? "background" : "main",
        status: hasActiveTask ? "queued" : "planning",
        prompt: content,
        attachments: imageAttachments.length > 0 ? imageAttachments : null,
        agentIdentity: resolvedAgentIdentity,
        runMode: runInBackground ? "background" : "foreground",
        wallClockCapMs,
        creditsReserved: reservedCredits,
        taskAgentMode: mode,
      })
      .returning();
    if (!task) {
      res.status(500).json({ error: "Failed to enqueue task" });
      return;
    }

    // Load image attachments as data URIs once, so build/refine paths can pass them
    // to the vision model just like the converse path does.
    const builderImageAttachments: Array<{ dataUri: string; alt?: string }> = [];
    for (const att of imageAttachments) {
      const dataUri = await fetchAttachmentAsDataUri(att.url);
      if (dataUri) builderImageAttachments.push({ dataUri, alt: att.alt });
    }
    const jobImageAttachments =
      builderImageAttachments.length > 0 ? builderImageAttachments : undefined;

    if (hasActiveTask) {
      // Emit a "queued" event immediately so the thinking bubble can show
      // "Waiting in queue…" instead of a blank "Starting up…" forever.
      await db.insert(taskEventsTable).values({
        taskId: task.id,
        eventType: "queued",
        message: "Task queued — waiting for the current build to finish…",
        filePath: null,
      });
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
        imageAttachments: jobImageAttachments,
        runMode: "background",
        wallClockCapMs: wallClockCapMs ?? undefined,
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
        imageAttachments: jobImageAttachments,
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

  // Background summarization: after every 20 user messages (across ALL intents —
  // converse, plan, and build), distil the older turns into a Knowledge Vault entry
  // so future calls of any kind have long-range context without bloating the prompt.
  setImmediate(() => {
    void (async () => {
      try {
        const [countRow] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(chatMessagesTable)
          .where(
            and(eq(chatMessagesTable.projectId, project.id), eq(chatMessagesTable.role, "user")),
          );
        const userMsgCount = countRow?.count ?? 0;

        if (userMsgCount > 0 && userMsgCount % 20 === 0) {
          const allMessages = await db
            .select({ role: chatMessagesTable.role, content: chatMessagesTable.content })
            .from(chatMessagesTable)
            .where(eq(chatMessagesTable.projectId, project.id))
            .orderBy(asc(chatMessagesTable.createdAt));

          const turns: ConversationTurn[] = allMessages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

          // Summarise all turns except the last 16 (8 user+assistant pairs)
          // which are already loaded fresh into the prompt.
          const olderTurns = turns.slice(0, -16);
          if (olderTurns.length < 4) return;

          const summary = await runConversationSummarizePipeline(project.name, olderTurns);
          if (!summary) return;

          await writeKnowledge({
            title: `Conversation summary — ${project.name}`,
            content: summary,
            type: "conversation_summary",
            category: "note",
            severity: "info",
            projectId: project.id,
            userId: project.ownerId ?? undefined,
            tags: ["conversation", "context", "summary"],
          });
        }
      } catch (err) {
        logger.warn({ err }, "Background conversation summarization failed — non-fatal");
      }
    })();
  });

  const [assistantMessage] = await db
    .insert(chatMessagesTable)
    .values({
      projectId: project.id,
      role: "assistant",
      content: assistantContent,
      agentMode: mode,
      planMode: effectivePlanMode,
      plan: plan ?? undefined,
      origin: messageOrigin,
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

/**
 * POST /projects/:id/messages/stream
 *
 * SSE endpoint for conversational (converse-intent) messages.
 * Streams OpenAI tokens word-by-word so the UI feels instant.
 *
 * Event types emitted:
 *   {"type":"token","content":"…"}   — incremental text chunk
 *   {"type":"done","userMessageId":N,"assistantMessageId":N,"plan":{…}}  — stream complete
 *   {"type":"fallback","intent":"build"|"plan"}  — not a converse message; client should
 *                                                    re-send via the regular POST endpoint
 *   {"type":"error","message":"…"}   — something went wrong
 */
router.post(
  "/projects/:id/messages/stream",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
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
      agentIntent: explicitAgentIntent,
      attachments: rawAttachments,
      origin: streamOrigin,
    } = parsed.data;
    const mode = agentMode as AgentMode;
    const attachments = Array.isArray(rawAttachments) ? rawAttachments : [];
    const imageAttachments = attachments.filter(
      (a) => a.kind === "image" && typeof a.url === "string",
    );

    // Gate all converse-family intents (converse, debug, refactor, review, explain) behind a
    // credit check BEFORE SSE headers are flushed so we can still return a proper HTTP 402.
    const converseIntents = ["converse", "debug", "refactor", "review", "explain"] as const;
    if (converseIntents.includes(explicitAgentIntent as (typeof converseIntents)[number])) {
      const converseOwner = req.userId ?? project.ownerId;
      if (converseOwner) {
        const intentLabel =
          explicitAgentIntent && explicitAgentIntent !== "converse"
            ? explicitAgentIntent.charAt(0).toUpperCase() + explicitAgentIntent.slice(1)
            : "Assistant chat";
        const deduction = await deductCreditsAtomic(converseOwner, 1, {
          type: "converse",
          description: `${intentLabel} — project ${project.id}`,
          projectId: project.id,
        });
        if ("insufficient" in deduction) {
          res.status(402).json({
            error: "Insufficient credits. Top up in Billing to continue.",
          });
          return;
        }
      }
    }

    // Set SSE headers before any await so the client sees the stream start quickly
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Track client disconnect so we can skip DB writes on abort
    const abortController = new AbortController();
    req.on("close", () => {
      abortController.abort();
    });

    const sendEvent = (data: Record<string, unknown>): void => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Load project files + recent conversation history
    const currentProjectFiles = await db
      .select({
        path: projectFilesTable.path,
        content: projectFilesTable.content,
        mimeType: projectFilesTable.mimeType,
      })
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, project.id));

    const recentMessages = await db
      .select({ role: chatMessagesTable.role, content: chatMessagesTable.content })
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.projectId, project.id))
      .orderBy(asc(chatMessagesTable.createdAt));

    const conversationHistory: ConversationTurn[] = recentMessages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
      .slice(-8);

    // Intent detection
    type StreamResolvedIntent =
      | "converse"
      | "plan"
      | "build"
      | "debug"
      | "refactor"
      | "review"
      | "explain";
    let resolvedIntent: StreamResolvedIntent = "build";
    let intentConfidence = 1.0;

    if (
      explicitAgentIntent === "converse" ||
      explicitAgentIntent === "plan" ||
      explicitAgentIntent === "build" ||
      explicitAgentIntent === "debug" ||
      explicitAgentIntent === "refactor" ||
      explicitAgentIntent === "review" ||
      explicitAgentIntent === "explain"
    ) {
      resolvedIntent = explicitAgentIntent as StreamResolvedIntent;
    } else if (planMode) {
      resolvedIntent = "plan";
    } else {
      const hasFiles = currentProjectFiles.length > 0;
      try {
        const classified = await runIntentClassifierPipeline(
          content,
          conversationHistory,
          hasFiles,
        );
        resolvedIntent = classified.intent as StreamResolvedIntent;
        intentConfidence = classified.confidence;
      } catch (err) {
        logger.warn({ err }, "Intent classifier failed in stream route, defaulting");
        resolvedIntent = hasFiles ? "build" : "converse";
      }
      if (intentConfidence < 0.7) {
        resolvedIntent = "converse";
      }
    }

    const isConverseFamily =
      resolvedIntent === "converse" ||
      resolvedIntent === "debug" ||
      resolvedIntent === "refactor" ||
      resolvedIntent === "review" ||
      resolvedIntent === "explain";

    // Non-converse: tell client to fall back to the regular endpoint
    if (!isConverseFamily) {
      sendEvent({ type: "fallback", intent: resolvedIntent });
      res.end();
      return;
    }

    const effectivePlanMode = planMode;
    const isAmbiguous = resolvedIntent === "converse" && intentConfidence < 0.7;
    const streamDeveloperIntentPrompts: Record<string, string> = {
      debug: (await import("../lib/builder")).DEBUG_SYSTEM_PROMPT,
      refactor: (await import("../lib/builder")).REFACTOR_SYSTEM_PROMPT,
      review: (await import("../lib/builder")).REVIEW_SYSTEM_PROMPT,
      explain: (await import("../lib/builder")).EXPLAIN_SYSTEM_PROMPT,
    };
    const streamSystemPromptOverride =
      resolvedIntent !== "converse" ? streamDeveloperIntentPrompts[resolvedIntent] : undefined;

    // Save user message
    const streamMessageOrigin =
      typeof streamOrigin === "string" && streamOrigin.length > 0 ? streamOrigin : null;
    let userMessageId: number;
    try {
      const [userMessage] = await db
        .insert(chatMessagesTable)
        .values({
          projectId: project.id,
          role: "user",
          content,
          agentMode: mode,
          planMode: effectivePlanMode,
          attachments: imageAttachments.length > 0 ? imageAttachments : undefined,
          origin: streamMessageOrigin,
        })
        .returning();
      if (!userMessage) throw new Error("Failed to save user message");
      userMessageId = userMessage.id;
    } catch (err) {
      sendEvent({ type: "error", message: "Failed to save message" });
      res.end();
      return;
    }

    // Create a converse task record
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

      // Build system prompt: use developer pair-programmer prompt when the
      // client explicitly set agentIntent=converse (i.e. "Assistant" mode).
      const DEVELOPER_PAIR_PROGRAMMER_PROMPT = `You are MustaFlow Assistant — an expert developer pair programmer with deep knowledge of TypeScript, JavaScript, Python, Go, React, Node.js, Express, SQL, and system design. You help developers debug errors, review code quality, explain architecture decisions, and suggest refactors. Match the technical depth of the user: use precise developer language when they do; plain language otherwise. When recommending a specific file change, wrap the new content in a fenced code block with the filename as the language tag (e.g. \`\`\`src/api/auth.ts).`;

      const hasDeveloperSignals =
        /```|\.ts\b|\.tsx\b|\.js\b|\.py\b|\.go\b|error:|Error:|TypeError|at \w+\s*\(|stack trace|undefined is not|cannot read/i.test(
          content,
        );

      const systemPromptOverride =
        explicitAgentIntent === "converse"
          ? hasDeveloperSignals
            ? `${DEVELOPER_PAIR_PROGRAMMER_PROMPT}\n\nThe user appears to be a technical developer — use precise developer language.`
            : DEVELOPER_PAIR_PROGRAMMER_PROMPT
          : undefined;

      // Stream tokens directly to the client
      const converseResult = await runConverseStreamPipeline(
        {
          projectName: project.name,
          userPrompt: content,
          conversationHistory,
          currentFiles: currentProjectFiles,
          agentMode: mode,
          isAmbiguous,
          imageAttachments: visionParts.length > 0 ? visionParts : undefined,
          signal: abortController.signal,
          systemPromptOverride,
        },
        (token) => {
          sendEvent({ type: "token", content: token });
        },
      );

      // Client disconnected mid-stream — discard partial result, skip DB writes
      if (abortController.signal.aborted) {
        if (converseTask) {
          await db
            .update(agentTasksTable)
            .set({ status: "failed", result: "Aborted by client", completedAt: sql`now()` })
            .where(eq(agentTasksTable.id, converseTask.id));
        }
        res.end();
        return;
      }

      // Update task status
      if (converseTask) {
        await db
          .update(agentTasksTable)
          .set({ status: "completed", result: converseResult.markdown, completedAt: sql`now()` })
          .where(eq(agentTasksTable.id, converseTask.id));
      }

      // Build the plan payload
      let plan: Record<string, unknown>;
      if (converseResult.clarifying) {
        plan = {
          kind: "clarifying",
          question: converseResult.clarifying.question,
          options: converseResult.clarifying.options,
          taskId,
        };
      } else {
        plan = {
          kind: "converse",
          taskId,
          intent: resolvedIntent !== "converse" ? resolvedIntent : undefined,
        };
      }

      // Save the assistant message
      const [assistantMessage] = await db
        .insert(chatMessagesTable)
        .values({
          projectId: project.id,
          role: "assistant",
          content: converseResult.markdown,
          agentMode: mode,
          planMode: effectivePlanMode,
          plan,
          origin: streamMessageOrigin,
        })
        .returning();

      if (!assistantMessage) throw new Error("Failed to save assistant message");

      // Update project activity timestamp
      await db
        .update(projectsTable)
        .set({ updatedAt: sql`now()`, lastTaskSummary: content.slice(0, 140), agentMode: mode })
        .where(eq(projectsTable.id, project.id));

      sendEvent({
        type: "done",
        userMessageId,
        assistantMessageId: assistantMessage.id,
        plan,
      });
    } catch (err) {
      // Client aborted mid-stream — just mark task failed, no error message to DB
      if (abortController.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        if (converseTask) {
          await db
            .update(agentTasksTable)
            .set({ status: "failed", result: "Aborted by client", completedAt: sql`now()` })
            .where(eq(agentTasksTable.id, converseTask.id));
        }
        res.end();
        return;
      }
      const msg = err instanceof Error ? err.message : "Conversation failed";
      if (converseTask) {
        await db
          .update(agentTasksTable)
          .set({ status: "failed", result: msg, completedAt: sql`now()` })
          .where(eq(agentTasksTable.id, converseTask.id));
      }
      // Save a fallback error message to the DB
      try {
        const [errMsg] = await db
          .insert(chatMessagesTable)
          .values({
            projectId: project.id,
            role: "assistant",
            content: `I wasn't able to answer that: ${msg}`,
            agentMode: mode,
            planMode: effectivePlanMode,
            plan: { kind: "error", message: msg },
            origin: streamMessageOrigin,
          })
          .returning();
        sendEvent({
          type: "error",
          message: msg,
          userMessageId,
          assistantMessageId: errMsg?.id,
        });
      } catch {
        sendEvent({ type: "error", message: msg, userMessageId });
      }
    }

    res.end();
  },
);

export default router;
