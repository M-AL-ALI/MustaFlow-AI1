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
  backgroundWallClockFor,
  runCancellablePlanTask,
} from "../lib/jobs";
import { deductCreditsAtomic } from "./credits";
import { settleCreditsDurably } from "../lib/billing-settlement-outbox";
import { logger } from "../lib/logger";
import { writeKnowledge } from "../lib/knowledge";
import { fetchAttachmentAsDataUri } from "./images";
import { createStreamSession, getStreamSession } from "../lib/stream-sessions";
import {
  backgroundPlanStepStatus,
  shouldStageBackgroundPlanStep,
} from "../lib/background-plan-step";
import { publishTaskEvent } from "../lib/event-bus";

const router: IRouter = Router();

function checkpointIdFromPlan(plan: Record<string, unknown> | null): number | null {
  const report = plan?.kind === "report" ? plan.report : null;
  if (!report || typeof report !== "object") return null;
  const versionId = (report as { versionId?: unknown }).versionId;
  return typeof versionId === "number" && Number.isFinite(versionId) ? versionId : null;
}

function compactTaskMemoryText(value: string, maxLength = 900): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function rememberCompletedAgentTask(opts: {
  projectId: number;
  userId?: string | null;
  taskId: number;
  intent: string;
  userPrompt: string;
  assistantSummary: string;
  category: string;
  tags: string[];
}): void {
  void writeKnowledge({
    title: `Agent Zero ${opts.intent}: ${compactTaskMemoryText(opts.userPrompt, 80)}`,
    content: [
      `Task #${opts.taskId} completed.`,
      `User request: ${compactTaskMemoryText(opts.userPrompt, 700)}`,
      `Agent Zero response: ${compactTaskMemoryText(opts.assistantSummary, 1200)}`,
    ].join("\n\n"),
    type: "note",
    category: opts.category,
    severity: "info",
    projectId: opts.projectId,
    userId: opts.userId ?? undefined,
    relatedTaskId: opts.taskId,
    tags: ["agent-zero", "task-memory", ...opts.tags],
  });
}

// ---------------------------------------------------------------------------
// Idempotency store — in-memory dedup for retried POSTs caused by network blips
// ---------------------------------------------------------------------------
interface IdempotencyEntry {
  status: "in-flight" | "done";
  result?: unknown;
  timestamp: number;
}

const idempotencyStore = new Map<string, IdempotencyEntry>();
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Prune stale entries every 10 minutes so the map doesn't grow unbounded
const idempotencyCleanupTimer = setInterval(
  () => {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [key, entry] of idempotencyStore) {
      if (entry.timestamp < cutoff) idempotencyStore.delete(key);
    }
  },
  10 * 60 * 1000,
);
idempotencyCleanupTimer.unref?.();

async function emitPlanEvent(taskId: number, eventType: string, message: string): Promise<void> {
  try {
    const [row] = await db
      .insert(taskEventsTable)
      .values({ taskId, eventType, message, filePath: null })
      .returning();
    if (row) {
      publishTaskEvent({
        id: row.id,
        taskId: row.taskId,
        eventType: row.eventType,
        message: row.message,
        filePath: row.filePath ?? null,
        data: (row.data as Record<string, unknown> | undefined) ?? undefined,
        createdAt: row.createdAt,
      });
    }
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
    idempotencyKey,
    brainstormContext,
    deepReasoning: requestedDeepReasoning,
  } = parsed.data;
  let { content } = parsed.data;

  // Idempotency dedup — if this key was already processed, return the cached result
  if (idempotencyKey) {
    const existing = idempotencyStore.get(idempotencyKey);
    if (existing) {
      if (existing.status === "done" && existing.result !== undefined) {
        logger.info({ idempotencyKey }, "Idempotency hit: returning cached regular-message result");
        res.json(existing.result);
        return;
      }
      if (existing.status === "in-flight") {
        res.status(409).json({
          error:
            "A request with this idempotency key is already in progress. Please wait and retry.",
        });
        return;
      }
    }
    // Mark in-flight
    idempotencyStore.set(idempotencyKey, { status: "in-flight", timestamp: Date.now() });
  }
  const mode = agentMode as AgentMode;
  if (mode === "lite" && requestedDeepReasoning) {
    res.status(400).json({ error: "Deep Reasoning is not available in Lite mode." });
    return;
  }
  const deepReasoning = Boolean(requestedDeepReasoning);
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
  // Brainstorm context — if the user resolved a brainstorm session before sending
  // this message, attach the conversation thread as supplementary context so the
  // builder AI understands the nuances, priorities, and edge cases discussed.
  const hasBrainstormContext = Array.isArray(brainstormContext) && brainstormContext.length > 0;
  let userPromptWithContext = content;
  if (hasBrainstormContext) {
    const turns = (brainstormContext as Array<{ role: string; content: string }>)
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");
    userPromptWithContext =
      `${content}\n\n` +
      `[BRAINSTORM CONTEXT — conversation that shaped this request; use it to understand ` +
      `the user's intent, priorities, and edge cases]\n${turns}\n[END BRAINSTORM CONTEXT]`;
  }

  // Foreground requests that were queued by aiBuilderLimiter physically wait
  // in-line (HTTP connection held open) until a slot frees, then run here
  // synchronously. Only explicit background=true from the client triggers
  // the async background-job path.
  const runInBackground = Boolean(parsed.data.background);
  const stagedBackgroundPlanStep = shouldStageBackgroundPlanStep({
    prompt: content,
    background: runInBackground,
    planMode: Boolean(planMode),
  });

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
  type ResolvedIntent =
    | "converse"
    | "plan"
    | "build"
    | "debug"
    | "refactor"
    | "review"
    | "explain"
    | "fix_tests"
    | "fix_types"
    | "fix_lint"
    | "image_generate";

  // Pattern for detecting explicit image generation requests in Ora chat.
  // Only fires when there is no explicit agentIntent override and planMode is off.
  //
  // Uses three gated paths to avoid misrouting builder/developer prompts:
  //   Path A — strong image-generation verbs (generate/draw/render/produce) with any
  //             visual-asset noun; or weaker verbs (create/make/design) with the same
  //             nouns, guarded by a negative lookahead that blocks code-object suffixes
  //             ("component", "element", "widget", "function", "hook", etc.) so that
  //             "create an icon component" stays a builder intent.
  //   Path B — weaker verbs (create/make/design) only when followed by an explicit
  //             content-describing image noun AND a subject preposition
  //             ("of/showing/depicting/featuring").
  //   Path C — purely visual real-world artifact nouns (painting/portrait/watercolor/…)
  //             that never appear in a code-writing task, regardless of verb.
  // Matches image-generation intent across a wide range of natural phrasings.
  // Covers both singular and plural nouns, and weak-verb+preposition variants.
  // Negative lookahead prevents "create an icon component" from being misrouted.
  // Covers singular/plural visual nouns, multi-word fillers ("me some", "a few"),
  // and purely-visual noun phrases that never appear in code-writing tasks.
  // Negative lookahead blocks "create an icon component" etc.
  const IMAGE_GENERATE_PATTERNS =
    /\b(?:generate|draw|render|produce|create|make|design|show\s+me)\s+(?:(?:a|an|me|us|some|my|the|few|several)\s+){0,3}(?:logo|logos|banner|banners|icon|icons|thumbnail|thumbnails|avatar|avatars|hero\s+images?|images?|pictures?|illustrations?|photos?|wallpapers?|background\s+images?|cover\s+(?:art|images?)|mockups?|posters?|flyers?|badges?|graphics?|visuals?|artworks?|artwork|paintings?|portraits?|murals?|watercolors?|sketches?)\b(?!\s+(?:component|element|widget|button|tab|panel|section|function|class|style|color|handler|hook|hooks|template|route|page|view|modal|menu|form|input|type|types|prop|props|state|util|utils|helper|helpers|module|library|lib|file|folder|dir|container|context|provider|reducer|action|slice|store|service|controller|model|schema|interface|enum|const|var|let))|\b(?:create|make|generate|design|draw|render|produce)\s+(?:(?:a|an|me|us|some|my)\s+){0,3}(?:images?|photos?|pictures?|illustrations?|artworks?|graphics?|visuals?)\s+(?:of|showing|depicting|featuring|with)\b|\b(?:create|make|generate|design|draw|render|produce)\s+(?:(?:a|an|me|us|some|my)\s+){0,3}(?:photorealistic\s+images?|ai\s+art)\b/i;

  // eslint-disable-next-line no-useless-assignment
  let resolvedIntent: ResolvedIntent = "build";
  let intentConfidence = 1.0;

  if (imageAttachments.length > 0) {
    // Screenshot-to-code: image attachments unconditionally route to build/refine —
    // skip classifier AND ignore any explicit intent/planMode from the client so the
    // vision model always runs (plan/converse don't support image inputs).
    resolvedIntent = "build";
    intentConfidence = 1.0;
  } else if (stagedBackgroundPlanStep) {
    // A decomposed plan step is an execution request, not another request to
    // plan. Pinning the intent also prevents the general classifier from
    // treating the generated "[Step n/m: ...]" wrapper as conversational text.
    resolvedIntent = "build";
    intentConfidence = 1.0;
  } else if (
    explicitAgentIntent === "converse" ||
    explicitAgentIntent === "plan" ||
    explicitAgentIntent === "build" ||
    explicitAgentIntent === "debug" ||
    explicitAgentIntent === "refactor" ||
    explicitAgentIntent === "review" ||
    explicitAgentIntent === "explain" ||
    explicitAgentIntent === "fix_tests" ||
    explicitAgentIntent === "fix_types" ||
    explicitAgentIntent === "fix_lint"
  ) {
    // Explicit client override takes second priority — always honor it,
    // even when the Plan Mode toggle is on (e.g. "Apply to app" must build).
    resolvedIntent = explicitAgentIntent as ResolvedIntent;
  } else if (planMode) {
    resolvedIntent = "plan";
  } else {
    // Check for explicit image generation requests before the general classifier.
    // This prevents image prompts from being misrouted to build/refine.
    if (IMAGE_GENERATE_PATTERNS.test(content)) {
      resolvedIntent = "image_generate";
    } else {
      // Run lightweight auto-classifier (gpt-5-nano) to detect intent
      const hasFiles = currentProjectFiles.length > 0;
      try {
        const classified = await runIntentClassifierPipeline(
          content,
          conversationHistory,
          hasFiles,
        );
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
  }

  // Effective planMode — true when explicitly toggled OR when intent classifier auto-routes to plan.
  // This ensures assistant messages are stored with planMode=true so the plan-card UI renders.
  const effectivePlanMode = planMode || resolvedIntent === "plan";

  // Provisioning gate: prevent build intents on agentic projects that have not
  // finished provisioning. Conversational intents (converse, plan, debug,
  // refactor, review, explain) are always allowed — they never write to the
  // container. We also allow when provisioningStatus is null / 'idle' so that
  // static and legacy projects are never gated.
  const needsContainer = resolvedIntent === "build" || runInBackground;
  if (needsContainer) {
    const bMode = (project as unknown as { builderMode?: string | null }).builderMode;
    const pStatus = (project as unknown as { provisioningStatus?: string | null })
      .provisioningStatus;
    if (bMode === "agentic" && pStatus != null && pStatus !== "ready" && pStatus !== "idle") {
      if (idempotencyKey) {
        idempotencyStore.set(idempotencyKey, {
          status: "done",
          result: undefined,
          timestamp: Date.now(),
        });
      }
      res.status(409).json({
        error:
          "Your project workspace is still being set up. Please wait a moment and try again once the provisioning completes.",
        code: "workspace_not_ready",
        provisioningStatus: pStatus,
      });
      return;
    }
  }

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
  let persistedAssistantMessage: typeof chatMessagesTable.$inferSelect | null = null;

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
        origin: messageOrigin,
        hasBrainstormContext,
        brainstormTurnCount: hasBrainstormContext
          ? (brainstormContext as Array<{ role: string; content: string }>).length
          : null,
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
      rememberCompletedAgentTask({
        projectId: project.id,
        userId: req.userId ?? project.ownerId,
        taskId,
        intent: resolvedIntent,
        userPrompt: content,
        assistantSummary: converseResult.markdown,
        category: resolvedIntent === "converse" ? "conversation" : resolvedIntent,
        tags: ["chat", resolvedIntent],
      });
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
  } else if (resolvedIntent === "image_generate") {
    // ── Async image generation via job queue ──────────────────────────────────
    // ISOLATION: uses dynamic imports to avoid coupling to the builder pipeline.
    // enqueueImageJob handles: safety check → rate limit check → credit deduction
    // → async generation (fire-and-forget) → R2 storage.
    // We return an image_pending card; the frontend polls GET /images/status/:jobId
    // every 2s until completed or failed.
    const imageCreditCost = 3; // standard quality for chat inline

    if (!req.userId) {
      // Unauthenticated visitor — return a static sign-up CTA instead of generating.
      // Never use project.ownerId as a credit source for anonymous users.
      assistantContent =
        "Image generation is available to registered users. Sign up for free to start creating images with Ora.";
      plan = { kind: "converse", taskId: 0 } as unknown as Record<string, unknown>;
    } else {
      const imageOwner = req.userId;
      const { isImageProviderConfigured } = await import("../lib/image-provider");
      if (!isImageProviderConfigured()) {
        assistantContent = "Image generation is not currently available on this server.";
        plan = { kind: "converse", taskId: 0 } as unknown as Record<string, unknown>;
      } else {
        try {
          const { enqueueImageJob } = await import("../lib/image-generation-jobs");
          const { jobId, imageId } = await enqueueImageJob({
            userId: imageOwner,
            prompt: content,
            quality: "standard",
            aspectRatio: "1:1",
            style: "vivid",
            projectId: project.id,
            persistToOraLibrary: true,
          });

          assistantContent = "Your image is being generated. It will appear here once ready.";
          plan = {
            kind: "image_pending",
            jobId,
            imageId,
            prompt: content,
            creditsCost: imageCreditCost,
          } as unknown as Record<string, unknown>;
        } catch (err) {
          const e = err as { code?: string; message?: string; balance?: number };
          if (e.code === "INSUFFICIENT_CREDITS") {
            res.status(402).json({
              error: "Insufficient credits for image generation. Top up in Billing to continue.",
            });
            return;
          }
          if (e.code === "SAFETY_BLOCKED") {
            assistantContent = `I can't generate that image: ${e.message ?? "the prompt failed safety validation"}.`;
            plan = { kind: "converse", taskId: 0 } as unknown as Record<string, unknown>;
          } else if (e.code === "RATE_LIMITED") {
            assistantContent =
              "Image generation rate limit reached. Please try again in a little while.";
            plan = { kind: "converse", taskId: 0 } as unknown as Record<string, unknown>;
          } else {
            logger.warn({ err }, "messages: image job enqueue failed");
            assistantContent = "Image generation failed unexpectedly. Please try again.";
            plan = { kind: "converse", taskId: 0 } as unknown as Record<string, unknown>;
          }
        }
      }
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
        origin: messageOrigin,
      })
      .returning();

    const taskId = planTask?.id ?? 0;

    const planOutcome = await runCancellablePlanTask({
      taskId,
      run: async (signal) => {
        await emitPlanEvent(taskId, "queued", "Plan request received…");
        await emitPlanEvent(taskId, "planning", "Analysing project and requirements…");
        await emitPlanEvent(taskId, "generating_blueprint", "Generating structured plan with AI…");

        return runPlanPipeline({
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
          deepReasoning,
          signal,
        });
      },
      commitCompleted: async (result) => {
        if (!planTask) return false;
        const [completedTask] = await db
          .update(agentTasksTable)
          .set({ status: "completed", result: result.summary, completedAt: sql`now()` })
          .where(and(eq(agentTasksTable.id, planTask.id), eq(agentTasksTable.status, "planning")))
          .returning({ id: agentTasksTable.id });
        return Boolean(completedTask);
      },
      commitCanceled: async () => {
        if (!planTask) return;
        await db
          .update(agentTasksTable)
          .set({ status: "canceled", completedAt: sql`now()` })
          .where(and(eq(agentTasksTable.id, planTask.id), eq(agentTasksTable.status, "planning")));
      },
      commitFailed: async (error) => {
        if (!planTask) return false;
        const message = error instanceof Error ? error.message : "Plan generation failed";
        const [failedTask] = await db
          .update(agentTasksTable)
          .set({ status: "failed", result: message, completedAt: sql`now()` })
          .where(and(eq(agentTasksTable.id, planTask.id), eq(agentTasksTable.status, "planning")))
          .returning({ id: agentTasksTable.id });
        return Boolean(failedTask);
      },
      emitTerminal: async (kind, value) => {
        if (kind === "cancelled") {
          await emitPlanEvent(taskId, "cancelled", "Plan cancelled by user.");
          return;
        }
        if (kind === "failed") {
          const message = value instanceof Error ? value.message : "Plan generation failed";
          await emitPlanEvent(taskId, "failed", message);
          return;
        }

        const result = value as Awaited<ReturnType<typeof runPlanPipeline>>;
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
      },
    });

    if (planOutcome.status === "completed") {
      assistantContent = planOutcome.value.summary;
      plan = planOutcome.value.plan;
      rememberCompletedAgentTask({
        projectId: project.id,
        userId: req.userId ?? project.ownerId,
        taskId,
        intent: "plan",
        userPrompt: content,
        assistantSummary: planOutcome.value.summary,
        category: "plan",
        tags: ["plan"],
      });
    } else if (planOutcome.status === "canceled") {
      assistantContent = "Plan cancelled by user.";
      plan = { kind: "cancelled", taskId };
    } else {
      const message =
        planOutcome.error instanceof Error ? planOutcome.error.message : "Plan generation failed";
      assistantContent = `Plan generation failed: ${message}`;
      plan = { kind: "error", message };
    }
  } else {
    // Determine if this is an initial build or a refinement
    const [existing] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(sql`(select 1 from project_files where project_id = ${project.id} limit 1) as f`);
    const hasFiles = (existing?.c ?? 0) > 0;
    const kind = hasFiles ? "refine" : "build";

    // fix_tests intent: prepend a structured test-fix loop instruction so the
    // agent starts by running tests rather than guessing what to fix.
    if (resolvedIntent === "fix_tests") {
      const userContext = userPromptWithContext.trim();
      const fixInstruction =
        `[TASK: Fix Failing Tests]\n` +
        `Start by calling \`run_tests\` with no arguments to get the current pass/fail status. ` +
        `Read the \`failedTests\` array in the result, locate each failing file with \`search\` and \`read_file\`, ` +
        `then fix the implementation (not the tests) using \`apply_patch\` or \`write_file\`. ` +
        `Re-run \`run_tests\` after each fix batch and repeat the loop until all tests pass or the step cap is reached. ` +
        `Finalize with a summary of tests fixed and any remaining failures.\n\n` +
        (userContext && !/^\[TASK:/i.test(userContext)
          ? `User context: ${userContext}`
          : userContext);
      userPromptWithContext = fixInstruction;
    }

    // fix_types intent: prepend a structured TypeScript-fix loop instruction so
    // the agent starts by running tsc rather than guessing what to fix.
    if (resolvedIntent === "fix_types") {
      const userContext = userPromptWithContext.trim();
      const fixInstruction =
        `[TASK: Fix TypeScript Errors]\n` +
        `Start by calling \`run_command\` with \`{"command": "npx tsc --noEmit 2>&1 | head -200"}\` (or the project's typecheck script if one exists in package.json) to get the full list of type errors. ` +
        `Parse the compiler output — each error has the form \`file.ts(line,col): error TSxxxx: message\`. Group errors by file to minimise round-trips. ` +
        `For each error group: \`read_file\` the affected file, understand the type mismatch, then fix it with \`apply_patch\` or \`write_file\`. Prefer the narrowest change — add a type annotation, fix the contract, or cast — rather than widening to \`any\`. ` +
        `After each fix batch, re-run \`run_command {"command": "npx tsc --noEmit 2>&1 | head -200"}\` to verify progress. Repeat (run tsc → read errors → patch → run tsc) until the output is empty or the step cap is reached. ` +
        `Finalize with a count of errors fixed and any remaining errors with their root cause.\n\n` +
        (userContext && !/^\[TASK:/i.test(userContext)
          ? `User context: ${userContext}`
          : userContext);
      userPromptWithContext = fixInstruction;
    }

    // fix_lint intent: prepend a structured ESLint-fix loop instruction so the
    // agent starts by running eslint rather than guessing what to fix.
    if (resolvedIntent === "fix_lint") {
      const userContext = userPromptWithContext.trim();
      const fixInstruction =
        `[TASK: Fix Lint Violations]\n` +
        `Start by calling \`run_command\` with \`{"command": "npx eslint . --ext .ts,.tsx,.js,.jsx --max-warnings 0 2>&1 | head -300"}\` (or the project's lint script if one is defined in package.json) to get the full violation list. ` +
        `Parse the output — each block is \`file path\\n  line:col  severity  rule-id  message\`. Group violations by file. ` +
        `For each file: \`read_file\` it, understand the violation (check the rule name if unclear), then fix it with \`apply_patch\` or \`write_file\`. Prefer code changes over disable comments — only use \`// eslint-disable-next-line\` when the violation is a false positive or intentional. ` +
        `After each fix batch, re-run the lint command to verify progress. Repeat until zero warnings/errors or the step cap is reached. ` +
        `If eslint is not installed, report that clearly in \`finalize\` rather than trying to install it. ` +
        `Finalize with a count of violations fixed and any remaining violations with their rule IDs.\n\n` +
        (userContext && !/^\[TASK:/i.test(userContext)
          ? `User context: ${userContext}`
          : userContext);
      userPromptWithContext = fixInstruction;
    }

    // Check for an active build/refine — prevent concurrent runs for the same project.
    // Review/fix gates are included so staged output cannot be overwritten before
    // the user applies, fixes, or discards it.
    // Background tasks (provisioning, blueprint npm-install, etc.) are excluded so
    // they do not block user-initiated runs.
    const [activeTask] = await db
      .select({ id: agentTasksTable.id })
      .from(agentTasksTable)
      .where(
        and(
          eq(agentTasksTable.projectId, project.id),
          inArray(agentTasksTable.status, ["building", "planning", "needs_review", "needs_fix"]),
          ne(agentTasksTable.kind, "background"),
        ),
      )
      .limit(1);
    const hasActiveTask = activeTask !== undefined;

    // Create a task row to track the work
    const safeExplicitAgentIdentity: AgentIdentity | undefined = stagedBackgroundPlanStep
      ? "task"
      : explicitAgentIdentity === "planning" && Boolean(planMode)
        ? "planning"
        : explicitAgentIdentity === "main"
          ? "main"
          : undefined;
    const resolvedAgentIdentity: AgentIdentity =
      safeExplicitAgentIdentity ??
      resolveAgentIdentity(content, hasFiles, runInBackground, hasActiveTask, Boolean(planMode));

    // Per-mode wall-clock cap for background runs (Task #509).
    const wallClockCapMs = runInBackground ? backgroundWallClockFor(mode) : null;

    let backgroundReservationCost: number | null = null;

    // NabuFlow billing gate (Task #1516): every build entry point passes the
    // single server-side resolver BEFORE a task row is created, so blocked
    // users get a calm structured 402 instead of a silently failed task.
    // runJob re-checks at start (authoritative for queued/drained work).
    if (project.ownerId) {
      const { resolveStageProvider, creditCostFor } = await import("../lib/ai-providers");
      const { provider: gateProvider } = resolveStageProvider(
        kind === "build" ? "build" : "refine",
        mode as Parameters<typeof creditCostFor>[0],
      );
      const gateCost = creditCostFor(
        mode as Parameters<typeof creditCostFor>[0],
        gateProvider,
        deepReasoning,
      );
      if (runInBackground) backgroundReservationCost = gateCost;
      const { nabuflowGateHttpError } = await import("../lib/nabuflow-billing");
      const gateErr = await nabuflowGateHttpError(project.ownerId, {
        engineMode: mode,
        deepReasoning,
        projectedCredits: gateCost,
        source: runInBackground ? "background" : "pipeline",
      });
      if (gateErr) {
        res.status(gateErr.status).json(gateErr.body);
        return;
      }
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
        origin: messageOrigin,
        runMode: runInBackground ? "background" : "foreground",
        wallClockCapMs,
        creditsReserved: null,
        taskAgentMode: mode,
        deepReasoning,
        hasBrainstormContext,
        brainstormTurnCount: hasBrainstormContext
          ? (brainstormContext as Array<{ role: string; content: string }>).length
          : null,
      })
      .returning();
    if (!task) {
      res.status(500).json({ error: "Failed to enqueue task" });
      return;
    }

    // Background work reserves the same flat pipeline price as foreground work,
    // but only after the task exists so every debit has an idempotent task key.
    if (runInBackground && project.ownerId && backgroundReservationCost != null) {
      const reservation = await settleCreditsDurably({
        ownerId: project.ownerId,
        amount: backgroundReservationCost,
        taskId: task.id,
        reservation: true,
        opts: {
          type: kind === "build" ? "build" : "refine",
          description: `Reserve for background task #${task.id} — project ${project.id} (${mode})`,
          projectId: project.id,
          taskId: task.id,
          engineMode: mode,
          deepReasoning,
          source: "pipeline",
        },
      });
      if ("insufficient" in reservation) {
        await db
          .update(agentTasksTable)
          .set({
            status: "failed",
            result: "Insufficient credits to reserve background run.",
            completedAt: sql`now()`,
          })
          .where(eq(agentTasksTable.id, task.id));
        res.status(402).json({ error: "Insufficient credits to reserve background run." });
        return;
      }
      if (!("deferred" in reservation)) {
        await db
          .update(agentTasksTable)
          .set({ creditsReserved: reservation.charged })
          .where(eq(agentTasksTable.id, task.id));
      }
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
      assistantContent = stagedBackgroundPlanStep
        ? backgroundPlanStepStatus(task.id, "queued")
        : `Your request has been queued as Task #${task.id}. It will run automatically when the current build finishes.`;
      plan = { kind: "task-queued", taskId: task.id } as unknown as Record<string, unknown>;
    } else if (runInBackground) {
      enqueueJob({
        taskId: task.id,
        projectId: project.id,
        kind,
        userPrompt: userPromptWithContext,
        agentMode: mode,
        deepReasoning,
        agentIdentity: resolvedAgentIdentity,
        origin: messageOrigin,
        conversationHistory,
        imageAttachments: jobImageAttachments,
        runMode: "background",
        wallClockCapMs: wallClockCapMs ?? undefined,
      });
      assistantContent = stagedBackgroundPlanStep
        ? backgroundPlanStepStatus(task.id, "queued")
        : `I've queued this in the background. Task #${task.id} is running and I'll post the report back here when it's done.`;
      plan = { kind: "task-queued", taskId: task.id } as unknown as Record<string, unknown>;
    } else {
      await runJob({
        taskId: task.id,
        projectId: project.id,
        kind,
        userPrompt: userPromptWithContext,
        agentMode: mode,
        deepReasoning,
        agentIdentity: resolvedAgentIdentity,
        origin: messageOrigin,
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
      if (refreshed?.report) {
        const checkpointId = checkpointIdFromPlan(plan);
        const [completionMessage] = await db
          .update(chatMessagesTable)
          .set({ origin: messageOrigin, checkpointId })
          .where(
            sql`id = (
              SELECT id FROM chat_messages
              WHERE project_id = ${project.id}
                AND (plan->>'kind') = 'report'
                AND (plan->>'taskId') = ${String(task.id)}
              ORDER BY created_at DESC
              LIMIT 1
            )`,
          )
          .returning();
        persistedAssistantMessage = completionMessage ?? null;
      }
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

  const checkpointId = checkpointIdFromPlan(plan);
  const [insertedAssistantMessage] = persistedAssistantMessage
    ? [persistedAssistantMessage]
    : await db
        .insert(chatMessagesTable)
        .values({
          projectId: project.id,
          role: "assistant",
          content: assistantContent,
          agentMode: mode,
          planMode: effectivePlanMode,
          plan: plan ?? undefined,
          origin: messageOrigin,
          checkpointId,
        })
        .returning();
  const assistantMessage = insertedAssistantMessage;
  if (!assistantMessage) {
    if (idempotencyKey) idempotencyStore.delete(idempotencyKey);
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

  const responsePayload = SendMessageResponse.parse({
    userMessage,
    assistantMessage,
    detectedIntent: resolvedIntent,
  });

  // Cache the result so a retried request with the same idempotency key gets the
  // same response without re-running the AI pipeline or deducting credits again.
  if (idempotencyKey) {
    idempotencyStore.set(idempotencyKey, {
      status: "done",
      result: responsePayload,
      timestamp: Date.now(),
    });
  }

  res.json(responsePayload);
});

/**
 * GET /projects/:id/messages/stream/resume
 *
 * SSE resume endpoint. A client that already received part of a stream can
 * reconnect here after a dropped connection without restarting the AI call.
 *
 * Query params:
 *   sessionId          — the streamSessionId received in the initial "session" event
 *   resumeAfterTokens  — how many token events the client already received (integer)
 *
 * The endpoint replays buffered tokens starting at `resumeAfterTokens`, then
 * continues forwarding new tokens as the original pipeline produces them, and
 * finally emits the "done" or "error" terminal event.
 */
router.get(
  "/projects/:id/messages/stream/resume",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const params = SendMessageParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const { sessionId, resumeAfterTokens: rawOffset } = req.query as Record<string, string>;
    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ error: "sessionId query param is required" });
      return;
    }

    const offset = Math.max(0, parseInt(rawOffset ?? "0", 10) || 0);

    const session = getStreamSession(sessionId);
    if (!session) {
      res.status(404).json({ error: "Stream session not found or expired" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const sendEvent = (data: Record<string, unknown>): void => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    };

    // Track client disconnect
    let clientGone = false;
    req.on("close", () => {
      clientGone = true;
    });

    // Replay already-buffered tokens the client has not yet seen
    const startIndex = offset;
    for (let i = startIndex; i < session.tokens.length; i++) {
      if (clientGone) {
        res.end();
        return;
      }
      sendEvent({ type: "token", content: session.tokens[i] });
    }

    // If the session is already complete, emit the terminal event and close
    if (session.complete) {
      if (session.errorPayload) {
        sendEvent({ type: "error", ...session.errorPayload });
      } else if (session.donePayload) {
        sendEvent({ type: "done", ...session.donePayload });
      }
      res.end();
      return;
    }

    // Session is still in progress — subscribe to new tokens via EventEmitter.
    // Register listeners BEFORE the double-check so we cannot miss the terminal
    // event if the pipeline completes between the first complete check and here.
    let nextIndex = session.tokens.length;

    const onToken = (): void => {
      if (clientGone) return;
      // Emit any tokens that arrived since we last checked
      while (nextIndex < session.tokens.length) {
        sendEvent({ type: "token", content: session.tokens[nextIndex] });
        nextIndex++;
      }
    };

    const onDone = (): void => {
      if (clientGone) {
        res.end();
        return;
      }
      if (session.donePayload) {
        sendEvent({ type: "done", ...session.donePayload });
      }
      res.end();
    };

    const onError = (): void => {
      if (clientGone) {
        res.end();
        return;
      }
      if (session.errorPayload) {
        sendEvent({ type: "error", ...session.errorPayload });
      }
      res.end();
    };

    session.emitter.on("token", onToken);
    session.emitter.once("done", onDone);
    session.emitter.once("error", onError);

    // Double-check: the pipeline may have completed between the initial
    // `session.complete` check above and the listener registration.
    // If so, flush any remaining tokens and emit the terminal event now.
    if (session.complete) {
      onToken(); // flush any tokens buffered since startIndex
      if (session.errorPayload) {
        onError();
      } else {
        onDone();
      }
      return;
    }

    // Keep-alive pings so proxies don't close the connection
    const keepAliveTimer = setInterval(() => {
      if (!res.writableEnded) res.write(": keep-alive\n\n");
    }, 15_000);

    const cleanup = (): void => {
      clearInterval(keepAliveTimer);
      session.emitter.off("token", onToken);
      session.emitter.off("done", onDone);
      session.emitter.off("error", onError);
    };

    res.on("close", cleanup);
    res.on("finish", cleanup);
  },
);

/**
 * POST /projects/:id/messages/stream
 *
 * SSE endpoint for conversational (converse-intent) messages.
 * Streams OpenAI tokens word-by-word so the UI feels instant.
 *
 * Event types emitted:
 *   {"type":"session","streamSessionId":"…"}  — first event; use for reconnect/resume
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
      idempotencyKey: streamIdempotencyKey,
      brainstormContext: streamBrainstormContext,
    } = parsed.data;
    const streamHasBrainstormContext =
      Array.isArray(streamBrainstormContext) && streamBrainstormContext.length > 0;
    const mode = agentMode as AgentMode;
    const attachments = Array.isArray(rawAttachments) ? rawAttachments : [];
    const imageAttachments = attachments.filter(
      (a) => a.kind === "image" && typeof a.url === "string",
    );

    // Idempotency dedup for the stream endpoint — must run BEFORE credit deduction
    // and BEFORE SSE headers so we can still return regular JSON responses here.
    if (streamIdempotencyKey) {
      const existing = idempotencyStore.get(streamIdempotencyKey);
      if (existing) {
        if (existing.status === "done" && existing.result !== undefined) {
          // Stream was already completed — return a minimal SSE that delivers the
          // cached done payload so the client can reconcile its UI state.
          logger.info(
            { idempotencyKey: streamIdempotencyKey },
            "Idempotency hit: replaying cached stream done event",
          );
          const cached = existing.result as {
            userMessageId: number;
            assistantMessageId: number;
            plan: Record<string, unknown>;
          };
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.setHeader("X-Accel-Buffering", "no");
          res.flushHeaders();
          res.write(`data: ${JSON.stringify({ type: "done", ...cached })}\n\n`);
          res.end();
          return;
        }
        if (existing.status === "in-flight") {
          // Another request with the same key is still being processed.
          res.status(409).json({
            error:
              "A request with this idempotency key is already in progress. Please wait and retry.",
          });
          return;
        }
      }
      // Mark as in-flight before starting any async work
      idempotencyStore.set(streamIdempotencyKey, { status: "in-flight", timestamp: Date.now() });
    }

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
          if (streamIdempotencyKey) idempotencyStore.delete(streamIdempotencyKey);
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

    // Create a stream session for resume support
    const { sessionId: streamSessionId, session: streamSession } = createStreamSession();

    const sendEvent = (data: Record<string, unknown>): void => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Emit the session ID as the very first event so the client can resume if dropped
    sendEvent({ type: "session", streamSessionId });

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
    // eslint-disable-next-line no-useless-assignment
    let resolvedIntent: StreamResolvedIntent = "build";
    let intentConfidence = 1.0;

    if (
      explicitAgentIntent === "converse" ||
      explicitAgentIntent === "plan" ||
      explicitAgentIntent === "build" ||
      explicitAgentIntent === "debug" ||
      explicitAgentIntent === "refactor" ||
      explicitAgentIntent === "review" ||
      explicitAgentIntent === "explain" ||
      explicitAgentIntent === "fix_tests" ||
      explicitAgentIntent === "fix_types" ||
      explicitAgentIntent === "fix_lint"
    ) {
      // fix_tests / fix_types / fix_lint are not converse-family intents — treat
      // them as build so the streaming route emits a fallback event and the
      // regular endpoint runs the full agentic loop with the prompt transformation.
      resolvedIntent =
        explicitAgentIntent === "fix_tests" ||
        explicitAgentIntent === "fix_types" ||
        explicitAgentIntent === "fix_lint"
          ? "build"
          : (explicitAgentIntent as StreamResolvedIntent);
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

    // Non-converse: tell client to fall back to the regular endpoint.
    // Clear the in-flight entry so the regular-endpoint call with the same
    // idempotency key is not blocked by the 409 guard.
    if (!isConverseFamily) {
      if (streamIdempotencyKey) idempotencyStore.delete(streamIdempotencyKey);
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
    const _streamSystemPromptOverride =
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
    } catch (_err) {
      if (streamIdempotencyKey) idempotencyStore.delete(streamIdempotencyKey);
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
        origin: streamMessageOrigin,
        hasBrainstormContext: streamHasBrainstormContext,
        brainstormTurnCount: streamHasBrainstormContext
          ? (streamBrainstormContext as Array<{ role: string; content: string }>).length
          : null,
      })
      .returning();

    const taskId = converseTask?.id ?? 0;

    // Keep-alive: emit a comment frame every 15 s so proxies / load-balancers
    // don't close the connection while the AI pipeline is running.
    // SSE comment lines (`: …\n\n`) are ignored by EventSource parsers.
    let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
    const stopKeepAlive = (): void => {
      if (keepAliveTimer !== undefined) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = undefined;
      }
    };
    // Always clear the interval when the response ends (covers unexpected closes
    // and abort paths where clearInterval hasn't been called yet).
    res.on("close", stopKeepAlive);
    res.on("finish", stopKeepAlive);

    try {
      const visionParts: ConverseImageAttachment[] = [];
      for (const att of imageAttachments) {
        const dataUri = await fetchAttachmentAsDataUri(att.url);
        if (dataUri) visionParts.push({ dataUri, alt: att.alt });
      }

      // Build system prompt: use developer pair-programmer prompt when the
      // client explicitly set agentIntent=converse (i.e. "Assistant" mode).
      const DEVELOPER_PAIR_PROGRAMMER_PROMPT = `You are NabuFlow Assistant — an expert developer pair programmer with deep knowledge of TypeScript, JavaScript, Python, Go, React, Node.js, Express, SQL, and system design. You help developers debug errors, review code quality, explain architecture decisions, and suggest refactors. Match the technical depth of the user: use precise developer language when they do; plain language otherwise. When recommending a specific file change, wrap the new content in a fenced code block with the filename as the language tag (e.g. \`\`\`src/api/auth.ts).`;

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

      // Start keep-alive pings while waiting for the AI pipeline
      keepAliveTimer = setInterval(() => {
        if (!res.writableEnded) {
          res.write(": keep-alive\n\n");
        }
      }, 15_000);

      // Stream tokens directly to the client, buffering each one for resume support
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
          streamSession.tokens.push(token);
          streamSession.emitter.emit("token");
          sendEvent({ type: "token", content: token });
        },
      );

      // Pipeline resolved — stop keep-alive pings
      stopKeepAlive();

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

      rememberCompletedAgentTask({
        projectId: project.id,
        userId: req.userId ?? project.ownerId,
        taskId,
        intent: resolvedIntent,
        userPrompt: content,
        assistantSummary: converseResult.markdown,
        category: resolvedIntent === "converse" ? "conversation" : resolvedIntent,
        tags: ["chat", "stream", resolvedIntent],
      });

      // Update project activity timestamp
      await db
        .update(projectsTable)
        .set({ updatedAt: sql`now()`, lastTaskSummary: content.slice(0, 140), agentMode: mode })
        .where(eq(projectsTable.id, project.id));

      const donePayload = {
        userMessageId,
        assistantMessageId: assistantMessage.id,
        plan,
      };

      // Cache the done payload so a retried request with the same idempotency key
      // gets the same result without re-running the AI pipeline or deducting credits.
      if (streamIdempotencyKey) {
        idempotencyStore.set(streamIdempotencyKey, {
          status: "done",
          result: donePayload,
          timestamp: Date.now(),
        });
      }
      // Mark session complete so resume clients get the terminal event
      streamSession.complete = true;
      streamSession.donePayload = donePayload;
      streamSession.emitter.emit("done");
      sendEvent({ type: "done", ...donePayload });
    } catch (err) {
      // Stop keep-alive pings on any error path
      stopKeepAlive();

      // Clear idempotency entry on any error/abort so retries with the same key
      // are not permanently blocked by a stale in-flight entry.
      if (streamIdempotencyKey) idempotencyStore.delete(streamIdempotencyKey);

      // Client aborted mid-stream — just mark task failed, no error message to DB
      if (abortController.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        if (converseTask) {
          await db
            .update(agentTasksTable)
            .set({ status: "failed", result: "Aborted by client", completedAt: sql`now()` })
            .where(eq(agentTasksTable.id, converseTask.id));
        }
        // Mark session complete so resume clients don't hang
        streamSession.complete = true;
        streamSession.emitter.emit("done");
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
        const errorPayload = {
          message: msg,
          userMessageId,
          assistantMessageId: errMsg?.id,
        };
        streamSession.complete = true;
        streamSession.errorPayload = errorPayload;
        streamSession.emitter.emit("error");
        sendEvent({ type: "error", ...errorPayload });
      } catch {
        const errorPayload = { message: msg, userMessageId };
        streamSession.complete = true;
        streamSession.errorPayload = errorPayload;
        streamSession.emitter.emit("error");
        sendEvent({ type: "error", ...errorPayload });
      }
    }

    res.end();
  },
);

export default router;
