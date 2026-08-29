import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { asc, and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  db,
  projectsTable,
  chatMessagesTable,
  agentTasksTable,
  taskEventsTable,
  knowledgeEntriesTable,
  supportZeroSessionsTable,
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
import type { ConversationTurn, ConverseImageAttachment, IntentResult } from "../lib/builder";
import { requireProjectOwnership } from "../lib/auth";
import { loadPrimaryArtifactFiles } from "../lib/artifacts";
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
import { describeConverseFailure } from "../lib/converse-failure";
import { ConverseCompletionInterruptedError } from "../lib/converse-completion";
import { writeKnowledge } from "../lib/knowledge";
import { projectSummaryProvenance } from "../lib/project-summary-provenance";
import { zeroProjectMemoryContext } from "../lib/zero-project-memory";
import { loadZeroProjectChoices } from "../lib/zero-project-choice-store";
import { readProjectMemoryReconciliationSummary } from "../lib/memory-reconciliation-reader";
import { fetchAttachmentAsDataUri } from "./images";
import { getOraAssetBytes } from "../lib/ora-assets";
import { createStreamSession, getStreamSession } from "../lib/stream-sessions";
import {
  backgroundPlanStepStatus,
  shouldStageBackgroundPlanStep,
} from "../lib/background-plan-step";
import { publishTaskEvent } from "../lib/event-bus";
import {
  intentReceiptEnforcementRequested,
  judgeZeroIntent,
  type ZeroIntentExplicitControl,
} from "../lib/zero-intent-judge";
import { intentReceiptStore } from "../lib/zero-intent-receipt-store";
import { governIntentAdmission } from "../lib/zero-intent-admission";
import {
  failedTerminal,
  interruptedTerminal,
  planSucceededTerminal,
  presentPersistedZeroTerminal,
  presentZeroTerminalV1,
  responseSucceededTerminal,
  isZeroProjectChoiceCaptureOnlyMessage,
  type IntentReceipt,
  type ZeroTerminalV1,
} from "@workspace/ora-contracts";
import {
  persistFailedZeroTerminal,
  persistInterruptedZeroTerminal,
  persistZeroTerminal,
  zeroTerminalRef,
} from "../lib/zero-terminal-persistence";
import {
  readApprovedSupportMutation,
  readSupportProposalRun,
  recordSupportGrantEvent,
  supportMutationStillAuthorized,
} from "../lib/support-access";
import { getSharedAccountProfile } from "../lib/clerk-users";
import { supportProposalReadyTemplate } from "../lib/emailTemplates";
import { deliverSupportConsequence, supportProductUrl } from "../lib/support-user-delivery";

const router: IRouter = Router();

async function requireProjectOwnerOrApprovedSupportOperator(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const projectId = Number(req.params.id);
  const sessionId = Number(req.body?.supportSessionId);
  if (req.userId && Number.isSafeInteger(projectId) && Number.isSafeInteger(sessionId)) {
    const input = { sessionId, projectId, actorUserId: req.userId };
    const authorized =
      (await readSupportProposalRun(input)) ?? (await readApprovedSupportMutation(input));
    if (authorized) {
      next();
      return;
    }
  }
  await requireProjectOwnership(req, res, next);
}

type SupportImageAttachment = {
  kind: "image";
  url: string;
  alt: string;
};

async function readSupportEvidenceImages(
  mutation:
    | NonNullable<Awaited<ReturnType<typeof readApprovedSupportMutation>>>
    | NonNullable<Awaited<ReturnType<typeof readSupportProposalRun>>>,
): Promise<{ model: SupportImageAttachment[]; receipt: SupportImageAttachment[] }> {
  const ticket = mutation.evidenceBundle.ticket;
  if (!ticket || typeof ticket !== "object" || Array.isArray(ticket))
    return { model: [], receipt: [] };
  const raw = (ticket as Record<string, unknown>).attachments;
  if (!Array.isArray(raw)) return { model: [], receipt: [] };
  const model: SupportImageAttachment[] = [];
  const receipt: SupportImageAttachment[] = [];
  for (const entry of raw.slice(0, 5)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const mime = typeof row.mimeType === "string" ? row.mimeType.toLowerCase() : "";
    const url = typeof row.url === "string" ? row.url : "";
    const assetId = Number(/\/api\/ora\/assets\/(\d+)\/download/u.exec(url)?.[1]);
    if (!mime.startsWith("image/") || !Number.isSafeInteger(assetId)) continue;
    const bytes = await getOraAssetBytes(assetId, mutation.ownerUserId);
    if (!bytes || bytes.length > 5 * 1024 * 1024) continue;
    const alt =
      typeof row.fileName === "string" && row.fileName.trim()
        ? `Support screenshot: ${row.fileName.trim().slice(0, 200)}`
        : "Support screenshot";
    model.push({ kind: "image", url: `data:${mime};base64,${bytes.toString("base64")}`, alt });
    receipt.push({ kind: "image", url, alt });
  }
  return { model, receipt };
}

function approvedSupportInstruction(input: {
  diagnosisInstruction: string;
  planSummary: string;
  plan: Record<string, unknown>;
}): string | null {
  const instruction = [
    "Apply the project owner's approved support proposal exactly as recorded below.",
    input.diagnosisInstruction,
    `Zero's approved plan summary: ${input.planSummary}`,
    `Zero's approved structured plan: ${JSON.stringify(input.plan)}`,
    "Run the relevant checks and record the resulting restorable project version. Do not broaden the change beyond this approved plan.",
  ].join("\n");
  return instruction.length <= 60_000 ? instruction : null;
}

async function readZeroProjectMemoryTruth(projectId: number) {
  try {
    return await readProjectMemoryReconciliationSummary(projectId);
  } catch (err) {
    logger.warn(
      {
        component: "zero-project-memory-reconciliation",
        errorClass: err instanceof Error ? err.name : "UnknownError",
        projectId,
      },
      "Zero withheld unverified app-state memory",
    );
    return null;
  }
}

async function persistAuthoritativeIntent(input: {
  projectId: number;
  requestId: string;
  legacyIntent(): string;
  explicitControl?: ZeroIntentExplicitControl;
  planMode: boolean;
  approvedPlanStep: boolean;
  imageGenerationRequested: boolean;
  attachments: readonly unknown[];
  conversationTurnCount: number;
  fileCount: number;
  classify(): Promise<IntentResult>;
}): Promise<IntentReceipt> {
  const replay = await intentReceiptStore.find(input.projectId, input.requestId);
  if (replay) {
    return replay;
  }
  const decision = await judgeZeroIntent(input);
  const receipt = await intentReceiptStore.persist(input.projectId, input.requestId, decision);
  const legacyIntent = input.legacyIntent();
  logger.info(
    {
      projectId: input.projectId,
      legacyIntent,
      shadowIntent: decision.intent,
      decidingSource: decision.decidingSource,
      reasonCode: decision.reasonCode,
      diverged: legacyIntent !== decision.intent,
      attachmentCount: input.attachments.length,
      conversationTurnCount: input.conversationTurnCount,
      fileCount: input.fileCount,
      enforcementRequested: intentReceiptEnforcementRequested(),
    },
    "zero-intent authoritative decision",
  );
  return receipt;
}

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

router.post(
  "/projects/:id/messages",
  requireProjectOwnerOrApprovedSupportOperator,
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
      agentIdentity: explicitAgentIdentity,
      agentIntent: explicitAgentIntent,
      attachments: rawAttachments,
      origin,
      idempotencyKey,
      supportSessionId,
      brainstormContext,
      deepReasoning: requestedDeepReasoning,
    } = parsed.data;
    const supportLookup = supportSessionId
      ? { sessionId: supportSessionId, projectId: project.id, actorUserId: req.userId! }
      : null;
    const supportProposal = supportLookup ? await readSupportProposalRun(supportLookup) : null;
    const supportMutation =
      supportLookup && !supportProposal ? await readApprovedSupportMutation(supportLookup) : null;
    const supportRun = supportProposal ?? supportMutation;
    if (supportSessionId && !supportRun) {
      res.status(409).json({
        error: "This support session is no longer available. Nothing was changed.",
        code: "support_session_unavailable",
      });
      return;
    }
    if (supportRun && process.env.NABUFLOW_GLOBAL_PAUSE === "true") {
      res.status(423).json({
        error: "NabuFlow is globally paused. No project change can start.",
        code: "support_global_pause",
      });
      return;
    }
    if (supportRun && content !== supportRun.instruction) {
      res.status(409).json({
        error: "The bound support instruction changed before it could run. Nothing was changed.",
        code: "support_proposal_mismatch",
      });
      return;
    }
    const expectedSupportIdempotency = supportProposal
      ? `support-proposal:${supportProposal.sessionId}`
      : supportMutation
        ? `support-session:${supportMutation.sessionId}`
        : null;
    if (supportRun && idempotencyKey !== expectedSupportIdempotency) {
      res.status(400).json({
        error: "This approved support change is missing its retry-safe identity.",
        code: "support_idempotency_required",
      });
      return;
    }
    // A stale or compromised client must not turn an explicit project-choice
    // capture into a mutation by attaching an authoritative-looking override.
    const authoritativeExplicitAgentIntent = supportProposal
      ? "plan"
      : supportMutation
        ? "mutate"
        : isZeroProjectChoiceCaptureOnlyMessage(content)
          ? "answer"
          : explicitAgentIntent;
    // Idempotency dedup — if this key was already processed, return the cached result
    if (idempotencyKey) {
      const existing = idempotencyStore.get(idempotencyKey);
      if (existing) {
        if (existing.status === "done" && existing.result !== undefined) {
          logger.info(
            { idempotencyKey },
            "Idempotency hit: returning cached regular-message result",
          );
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
    const supportEvidenceImages = supportRun
      ? await readSupportEvidenceImages(supportRun)
      : { model: [], receipt: [] };
    const imageAttachments = supportRun
      ? supportEvidenceImages.model
      : attachments.filter((a) => a.kind === "image" && typeof a.url === "string");
    const persistedImageAttachments = supportRun ? supportEvidenceImages.receipt : imageAttachments;

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

    // Planning and support proposals must see exactly the same primary-artifact
    // overlay that trusted builds consume. Sibling artifacts are separate apps,
    // not extra context for the active one.
    const currentProjectFiles = await loadPrimaryArtifactFiles(project.id);

    // Load recent conversation history for AI context (last 8 user/assistant turns)
    // Also load the most recent conversation summary for long-range context injection.
    const [recentMessages, summaryEntry, projectChoices, memoryTruth] = await Promise.all([
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
      loadZeroProjectChoices(project.id),
      readZeroProjectMemoryTruth(project.id),
    ]);

    const conversationSummary = summaryEntry[0]?.content;
    const projectMemoryContext = zeroProjectMemoryContext({
      projectId: project.id,
      projectName: project.name,
      description: project.description,
      summary: project.summary,
      lastTaskSummary: project.lastTaskSummary,
      conversationSummary,
      choices: projectChoices,
      reconciliation: memoryTruth,
    });

    const conversationHistory: ConversationTurn[] = recentMessages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }))
      .slice(-8);

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

    const imageGenerationRequested =
      authoritativeExplicitAgentIntent === undefined &&
      !planMode &&
      IMAGE_GENERATE_PATTERNS.test(content);
    let classifiedForReceipt: IntentResult | null = null;
    const classify = async (): Promise<IntentResult> => {
      classifiedForReceipt ??= await runIntentClassifierPipeline(
        content,
        conversationHistory,
        currentProjectFiles.length > 0,
      );
      return classifiedForReceipt;
    };
    let intentReceipt: IntentReceipt;
    try {
      intentReceipt = await persistAuthoritativeIntent({
        projectId: project.id,
        requestId: idempotencyKey ?? randomUUID(),
        legacyIntent: () => {
          if (imageAttachments.length > 0 || stagedBackgroundPlanStep || imageGenerationRequested) {
            return "build";
          }
          if (authoritativeExplicitAgentIntent) {
            return authoritativeExplicitAgentIntent;
          }
          if (planMode) return "plan";
          return classifiedForReceipt?.legacyIntent ?? "converse";
        },
        explicitControl: authoritativeExplicitAgentIntent as ZeroIntentExplicitControl | undefined,
        planMode: Boolean(planMode),
        approvedPlanStep: Boolean(stagedBackgroundPlanStep),
        imageGenerationRequested,
        attachments,
        conversationTurnCount: conversationHistory.length,
        fileCount: currentProjectFiles.length,
        classify,
      });
    } catch (error) {
      if (idempotencyKey) idempotencyStore.delete(idempotencyKey);
      logger.error(
        { projectId: project.id, errorType: error instanceof Error ? error.name : "UnknownError" },
        "zero-intent authoritative receipt unavailable",
      );
      res.status(503).json({
        error: "I couldn't safely determine what to do with that request. Please try again.",
        code: "intent_receipt_unavailable",
      });
      return;
    }
    const resolvedIntent = intentReceipt.intent;
    const terminalIntentReceiptId = intentReceipt.receiptId;
    if (supportProposal && resolvedIntent !== "plan") {
      res.status(409).json({
        error:
          "Zero could not bind this support session to a read-only proposal. Nothing was changed.",
        code: "support_proposal_intent_required",
      });
      return;
    }
    if (supportMutation && resolvedIntent !== "mutate") {
      res.status(409).json({
        error:
          "Zero could not bind this approved proposal to a project change. Nothing was changed.",
        code: "support_mutation_intent_required",
      });
      return;
    }

    // Effective planMode — true when explicitly toggled OR when intent classifier auto-routes to plan.
    // This ensures assistant messages are stored with planMode=true so the plan-card UI renders.
    const effectivePlanMode = resolvedIntent === "plan";

    // Provisioning gate: prevent build intents on agentic projects that have not
    // finished provisioning. Conversational intents (converse, plan, debug,
    // refactor, review, explain) are always allowed — they never write to the
    // container. We also allow when provisioningStatus is null / 'idle' so that
    // static and legacy projects are never gated.
    const needsContainer = resolvedIntent === "mutate" || runInBackground;
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
    const messageOrigin = supportRun
      ? `support-session:${supportRun.sessionId}`
      : typeof origin === "string" && origin.length > 0
        ? origin
        : null;
    const [userMessage] = await db
      .insert(chatMessagesTable)
      .values({
        projectId: project.id,
        role: "user",
        content,
        agentMode: mode,
        planMode: effectivePlanMode,
        attachments: persistedImageAttachments.length > 0 ? persistedImageAttachments : undefined,
        origin: messageOrigin,
        intentReceiptId: intentReceipt.receiptId,
        supportSessionId: supportRun?.sessionId ?? null,
        provenanceActorUserId: supportRun?.staffUserId ?? null,
      })
      .returning();
    if (!userMessage) {
      res.status(500).json({ error: "Failed to save message" });
      return;
    }
    try {
      await intentReceiptStore.linkMessage(intentReceipt.receiptId, userMessage.id);
    } catch (error) {
      logger.warn(
        {
          projectId: project.id,
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "zero-intent authoritative message link unavailable",
      );
    }

    let assistantContent: string;
    // eslint-disable-next-line no-useless-assignment
    let plan: Record<string, unknown> | null = null;
    let persistedAssistantMessage: typeof chatMessagesTable.$inferSelect | null = null;
    let terminalAfterAssistant: ((assistantMessageId: number) => ZeroTerminalV1) | null = null;
    let completedTerminal: ZeroTerminalV1 | null = null;
    let terminalMemory: {
      taskId: number;
      intent: string;
      category: string;
      tags: string[];
    } | null = null;

    const DEVELOPER_INTENT_SYSTEM_PROMPTS: Record<string, string> = {
      debug: (await import("../lib/builder")).DEBUG_SYSTEM_PROMPT,
      refactor: (await import("../lib/builder")).REFACTOR_SYSTEM_PROMPT,
      review: (await import("../lib/builder")).REVIEW_SYSTEM_PROMPT,
      explain: (await import("../lib/builder")).EXPLAIN_SYSTEM_PROMPT,
    };

    if (
      resolvedIntent === "answer" ||
      resolvedIntent === "clarify" ||
      resolvedIntent === "observe"
    ) {
      // ── Conversational / developer-intent path ───────────────────────────────
      // Creates a lightweight task record (kind="converse") for history tracking.
      // No files are written, no build report is generated.

      // Deduct 1 credit for all converse-family intents (converse, debug, refactor, review, explain).
      const converseOwner = req.userId ?? project.ownerId;
      if (converseOwner) {
        const deduction = await deductCreditsAtomic(converseOwner, 1, {
          type: "converse",
          description: `${resolvedIntent === "observe" ? "Project observation" : resolvedIntent === "clarify" ? "Clarifying question" : "Assistant chat"} — project ${project.id}`,
          projectId: project.id,
        });
        if ("insufficient" in deduction) {
          res.status(402).json({
            error: "Insufficient credits. Top up in Billing to continue.",
          });
          return;
        }
      }

      const isAmbiguous = resolvedIntent === "clarify";
      const systemPromptOverride =
        explicitAgentIntent === "debug" ||
        explicitAgentIntent === "refactor" ||
        explicitAgentIntent === "review" ||
        explicitAgentIntent === "explain"
          ? DEVELOPER_INTENT_SYSTEM_PROMPTS[explicitAgentIntent]
          : undefined;
      const [converseTask] = await db
        .insert(agentTasksTable)
        .values({
          projectId: project.id,
          title: `Chat: ${content.slice(0, 60)}`,
          kind: "converse",
          status: "answering",
          prompt: content,
          agentIdentity: "main",
          origin: messageOrigin,
          intentReceiptId: terminalIntentReceiptId,
          hasBrainstormContext,
          brainstormTurnCount: hasBrainstormContext
            ? (brainstormContext as Array<{ role: string; content: string }>).length
            : null,
        })
        .returning();

      if (converseTask) {
        await governIntentAdmission({
          phase: "creator",
          projectId: project.id,
          taskId: converseTask.id,
          requestId: intentReceipt.requestId,
          mutationCapable: false,
          receipt: intentReceipt,
        });
      }

      const taskId = converseTask?.id ?? 0;

      try {
        const visionParts: ConverseImageAttachment[] = [];
        for (const att of imageAttachments) {
          const dataUri =
            supportRun && att.url.startsWith("data:image/")
              ? att.url
              : await fetchAttachmentAsDataUri(att.url, project.id);
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
          conversationSummary: projectMemoryContext,
          systemPromptOverride,
          taskId: converseTask?.id,
        });

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
            intent: resolvedIntent,
            streaming: true,
          } as unknown as Record<string, unknown>;
        }
        if (converseTask) {
          terminalAfterAssistant = (assistantMessageId) =>
            responseSucceededTerminal({
              schema: "zero-terminal-v1",
              taskId,
              intent: resolvedIntent,
              intentReceiptId: terminalIntentReceiptId,
              completedAt: new Date().toISOString(),
              outcome: "response_succeeded",
              runStatus: "completed",
              evidence: {
                assistantMessageId,
                stopEvidence: converseResult.stopEvidence,
              },
            });
          terminalMemory = {
            taskId,
            intent: resolvedIntent,
            category: resolvedIntent === "answer" ? "conversation" : resolvedIntent,
            tags: ["chat", resolvedIntent],
          };
        }
      } catch (err) {
        const interruption = err instanceof ConverseCompletionInterruptedError ? err : null;
        const failure = interruption ? null : describeConverseFailure(err);
        if (converseTask && interruption) {
          const terminal = interruptedTerminal({
            schema: "zero-terminal-v1",
            taskId,
            intent: resolvedIntent,
            intentReceiptId: terminalIntentReceiptId,
            completedAt: new Date().toISOString(),
            outcome: "interrupted",
            runStatus: "interrupted",
            cause: interruption.code,
            evidence: { lastPhase: "response", changedPaths: [] },
          });
          terminalAfterAssistant = () => terminal;
          assistantContent =
            interruption.partialText.trim() || presentZeroTerminalV1(terminal).message;
          plan = {
            kind: "interrupted",
            message: presentZeroTerminalV1(terminal).message,
            retry: true,
          } as unknown as Record<string, unknown>;
        } else if (converseTask && failure) {
          const terminal = failedTerminal({
            schema: "zero-terminal-v1",
            taskId,
            intent: resolvedIntent,
            intentReceiptId: terminalIntentReceiptId,
            completedAt: new Date().toISOString(),
            outcome: "failed",
            runStatus: "failed",
            cause: { code: failure.code, stage: "response" },
            evidence: { summary: failure.message },
          });
          terminalAfterAssistant = () => terminal;
          assistantContent = presentZeroTerminalV1(terminal).message;
          plan = { kind: "error", message: assistantContent } as unknown as Record<string, unknown>;
        } else {
          assistantContent =
            interruption?.partialText.trim() ||
            (interruption
              ? "Zero's response was cut short. Please try again."
              : (failure?.message ?? "I wasn't able to answer that request."));
          plan = {
            kind: interruption ? "interrupted" : "error",
            message: interruption
              ? "Zero's response was cut short. Please try again."
              : assistantContent,
            ...(interruption ? { retry: true } : {}),
          } as unknown as Record<string, unknown>;
        }
      }
    } else if (imageGenerationRequested) {
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
          intentReceiptId: terminalIntentReceiptId,
          supportSessionId: supportProposal?.sessionId ?? null,
          provenanceActorUserId: supportProposal?.staffUserId ?? null,
        })
        .returning();

      if (planTask) {
        await governIntentAdmission({
          phase: "creator",
          projectId: project.id,
          taskId: planTask.id,
          requestId: intentReceipt.requestId,
          mutationCapable: false,
          receipt: intentReceipt,
        });
      }

      const taskId = planTask?.id ?? 0;

      if (supportProposal && planTask) {
        const [claimed] = await db
          .update(supportZeroSessionsTable)
          .set({ taskId: planTask.id })
          .where(
            and(
              eq(supportZeroSessionsTable.id, supportProposal.sessionId),
              eq(supportZeroSessionsTable.status, "diagnosing"),
              isNull(supportZeroSessionsTable.taskId),
            ),
          )
          .returning({ id: supportZeroSessionsTable.id });
        if (!claimed) {
          await db.delete(agentTasksTable).where(eq(agentTasksTable.id, planTask.id));
          await db.delete(chatMessagesTable).where(eq(chatMessagesTable.id, userMessage.id));
          res.status(409).json({
            error: "This support proposal has already started.",
            code: "support_proposal_already_started",
          });
          return;
        }
      }

      const planOutcome = await runCancellablePlanTask({
        taskId,
        run: async (signal) => {
          if (
            supportProposal &&
            !(await supportMutationStillAuthorized({
              sessionId: supportProposal.sessionId,
              projectId: project.id,
            }))
          ) {
            throw new Error("Support access ended");
          }
          await emitPlanEvent(taskId, "queued", "Plan request received…");
          await emitPlanEvent(taskId, "planning", "Analysing project and requirements…");
          await emitPlanEvent(
            taskId,
            "generating_blueprint",
            "Generating structured plan with AI…",
          );

          const result = await runPlanPipeline({
            projectName: project.name,
            projectKind: project.kind,
            projectFormat: project.projectFormat,
            projectStack: project.stack,
            preserveProjectArchitecture: Boolean(supportProposal),
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
          if (
            supportProposal &&
            !(await supportMutationStillAuthorized({
              sessionId: supportProposal.sessionId,
              projectId: project.id,
            }))
          ) {
            throw new Error("Support access ended");
          }
          return result;
        },
        commitCompleted: async (result) => {
          return Boolean(planTask && result);
        },
        commitCanceled: async () => undefined,
        commitFailed: async () => Boolean(planTask),
        emitTerminal: async () => undefined,
      });

      if (planOutcome.status === "completed") {
        assistantContent = planOutcome.value.summary;
        plan = planOutcome.value.plan;
        if (planTask) {
          terminalAfterAssistant = (assistantMessageId) =>
            planSucceededTerminal({
              schema: "zero-terminal-v1",
              taskId,
              intent: "plan",
              intentReceiptId: terminalIntentReceiptId,
              completedAt: new Date().toISOString(),
              outcome: "plan_succeeded",
              runStatus: "completed",
              evidence: {
                assistantMessageId,
                planRef: { kind: "chat_message_plan", messageId: assistantMessageId },
              },
            });
          terminalMemory = { taskId, intent: "plan", category: "plan", tags: ["plan"] };
        }
      } else if (planOutcome.status === "canceled") {
        plan = { kind: "cancelled", taskId };
        if (planTask) {
          const terminal = interruptedTerminal({
            schema: "zero-terminal-v1",
            taskId,
            intent: "plan",
            intentReceiptId: terminalIntentReceiptId,
            completedAt: new Date().toISOString(),
            outcome: "interrupted",
            runStatus: "interrupted",
            cause: "user_stop",
            evidence: { lastPhase: "planning", changedPaths: [] },
          });
          terminalAfterAssistant = () => terminal;
          assistantContent = presentZeroTerminalV1(terminal).message;
        } else {
          assistantContent = "This run was interrupted.";
        }
      } else {
        if (planTask) {
          const terminal = failedTerminal({
            schema: "zero-terminal-v1",
            taskId,
            intent: "plan",
            intentReceiptId: terminalIntentReceiptId,
            completedAt: new Date().toISOString(),
            outcome: "failed",
            runStatus: "failed",
            cause: { code: "plan_failed", stage: "planning" },
            evidence: { summary: "The plan could not be prepared." },
          });
          terminalAfterAssistant = () => terminal;
          assistantContent = presentZeroTerminalV1(terminal).message;
        } else {
          assistantContent = "The plan could not be prepared.";
        }
        plan = { kind: "error", message: assistantContent };
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
      if (explicitAgentIntent === "fix_tests") {
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
      if (explicitAgentIntent === "fix_types") {
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
      if (explicitAgentIntent === "fix_lint") {
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
          attachments: persistedImageAttachments.length > 0 ? persistedImageAttachments : null,
          agentIdentity: resolvedAgentIdentity,
          origin: messageOrigin,
          runMode: runInBackground ? "background" : "foreground",
          wallClockCapMs,
          creditsReserved: null,
          taskAgentMode: mode,
          deepReasoning,
          hasBrainstormContext,
          supportSessionId: supportMutation?.sessionId ?? null,
          provenanceActorUserId: supportMutation?.staffUserId ?? null,
          brainstormTurnCount: hasBrainstormContext
            ? (brainstormContext as Array<{ role: string; content: string }>).length
            : null,
        })
        .returning();
      if (!task) {
        res.status(500).json({ error: "Failed to enqueue task" });
        return;
      }
      if (supportMutation) {
        const [claimed] = await db
          .update(supportZeroSessionsTable)
          .set({ status: "applying", taskId: task.id })
          .where(
            and(
              eq(supportZeroSessionsTable.id, supportMutation.sessionId),
              eq(supportZeroSessionsTable.status, "approved"),
            ),
          )
          .returning({ id: supportZeroSessionsTable.id });
        if (!claimed) {
          await db.delete(agentTasksTable).where(eq(agentTasksTable.id, task.id));
          res.status(409).json({
            error: "This approved support change has already started.",
            code: "support_session_already_started",
          });
          return;
        }
      }
      const admission = await governIntentAdmission({
        phase: "creator",
        projectId: project.id,
        taskId: task.id,
        requestId: intentReceipt.requestId,
        mutationCapable: true,
        receipt: intentReceipt,
      });
      if (!Number.isInteger(admission.receiptId) || (admission.receiptId ?? 0) < 1) {
        throw new Error("The mutation intent receipt was not recorded");
      }
      const mutationIntentReceiptId = admission.receiptId as number;
      await db
        .update(agentTasksTable)
        .set({ intentReceiptId: mutationIntentReceiptId })
        .where(eq(agentTasksTable.id, task.id));

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
          await persistFailedZeroTerminal({
            taskId: task.id,
            intent: "mutate",
            intentReceiptId: mutationIntentReceiptId,
            cause: { code: "background_reservation_unavailable", stage: "admission" },
            summary: "Insufficient credits to reserve background run.",
            allowedStatuses: ["queued", "planning"],
          });
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
        const dataUri =
          supportRun && att.url.startsWith("data:image/")
            ? att.url
            : await fetchAttachmentAsDataUri(att.url, project.id);
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
          intentReceiptId: admission.receiptId,
          supportSessionId: supportMutation?.sessionId,
          provenanceActorUserId: supportMutation?.staffUserId,
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
          intentReceiptId: admission.receiptId,
          supportSessionId: supportMutation?.sessionId,
          provenanceActorUserId: supportMutation?.staffUserId,
        });
        const [refreshed] = await db
          .select()
          .from(agentTasksTable)
          .where(eq(agentTasksTable.id, task.id));
        const persistedTerminalPresentation = presentPersistedZeroTerminal(refreshed?.terminal);
        assistantContent =
          persistedTerminalPresentation?.message ?? "Outcome unavailable for this run.";
        plan = refreshed?.report
          ? ({
              kind: "report",
              report: refreshed.report,
              taskId: task.id,
              ...(refreshed?.terminal
                ? {
                    terminalRef: {
                      kind: "zero_terminal",
                      schema: "zero-terminal-v1",
                      taskId: task.id,
                    },
                  }
                : {}),
            } as unknown as Record<string, unknown>)
          : ({ kind: "outcome-unavailable", taskId: task.id } as unknown as Record<
              string,
              unknown
            >);
        if (refreshed?.report) {
          plan = { ...plan, intent: resolvedIntent };
          const checkpointId = checkpointIdFromPlan(plan);
          const [completionMessage] = await db
            .update(chatMessagesTable)
            .set({
              origin: messageOrigin,
              checkpointId,
              plan: sql`COALESCE(${chatMessagesTable.plan}, '{}'::jsonb) || ${JSON.stringify({
                intent: resolvedIntent,
              })}::jsonb`,
            })
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
              .select({
                id: chatMessagesTable.id,
                role: chatMessagesTable.role,
                content: chatMessagesTable.content,
              })
              .from(chatMessagesTable)
              .where(eq(chatMessagesTable.projectId, project.id))
              .orderBy(asc(chatMessagesTable.createdAt));

            const conversationMessages = allMessages.filter(
              (message) => message.role === "user" || message.role === "assistant",
            );
            const turns: ConversationTurn[] = conversationMessages.map((m) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
            }));

            // Summarise all turns except the last 16 (8 user+assistant pairs)
            // which are already loaded fresh into the prompt.
            const olderTurns = turns.slice(0, -16);
            if (olderTurns.length < 4) return;
            const sourceMessages = conversationMessages.slice(0, -16);
            const sourceMessageStartId = sourceMessages.at(0)?.id;
            const sourceMessageEndId = sourceMessages.at(-1)?.id;
            if (sourceMessageStartId == null || sourceMessageEndId == null) return;

            const summary = await runConversationSummarizePipeline(project.name, olderTurns);
            if (!summary) return;

            const receipt = await writeKnowledge({
              title: `Conversation summary — ${project.name}`,
              content: summary,
              type: "conversation_summary",
              category: "note",
              severity: "info",
              projectId: project.id,
              userId: project.ownerId ?? undefined,
              sourceMessageStartId,
              sourceMessageEndId,
              tags: ["conversation", "context", "summary"],
              claimKind: "inferred",
              actorUserId: project.ownerId ?? undefined,
            });
            if (receipt) {
              logger.debug(
                { projectId: project.id, ...receipt },
                "Conversation summary knowledge provenance recorded",
              );
            }
          }
        } catch (err) {
          logger.warn({ err }, "Background conversation summarization failed — non-fatal");
        }
      })();
    });

    const planWithIntent = { ...(plan ?? {}), intent: resolvedIntent };
    const checkpointId = checkpointIdFromPlan(planWithIntent);
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
            plan: planWithIntent,
            origin: messageOrigin,
            checkpointId,
            supportSessionId: supportRun?.sessionId ?? null,
            provenanceActorUserId: supportRun?.staffUserId ?? null,
          })
          .returning();
    const assistantMessage = insertedAssistantMessage;
    if (!assistantMessage) {
      if (idempotencyKey) idempotencyStore.delete(idempotencyKey);
      res.status(500).json({ error: "Failed to save assistant message" });
      return;
    }

    if (terminalAfterAssistant) {
      const terminal = terminalAfterAssistant(assistantMessage.id);
      completedTerminal = terminal;
      const persisted = await persistZeroTerminal({
        terminal,
        allowedStatuses: ["answering", "planning"],
      });
      if (!persisted) {
        if (idempotencyKey) idempotencyStore.delete(idempotencyKey);
        res.status(409).json({ error: "The run ended before its outcome could be recorded." });
        return;
      }
      const ref = zeroTerminalRef(terminal);
      await db
        .update(chatMessagesTable)
        .set({
          plan: sql`COALESCE(${chatMessagesTable.plan}, '{}'::jsonb) || ${JSON.stringify({ terminalRef: ref })}::jsonb`,
        })
        .where(eq(chatMessagesTable.id, assistantMessage.id));
      if (terminalMemory && terminal.outcome !== "interrupted" && terminal.outcome !== "failed") {
        rememberCompletedAgentTask({
          projectId: project.id,
          userId: req.userId ?? project.ownerId,
          taskId: terminalMemory.taskId,
          intent: terminalMemory.intent,
          userPrompt: content,
          assistantSummary: assistantContent,
          category: terminalMemory.category,
          tags: terminalMemory.tags,
        });
      }
    }

    if (supportProposal) {
      const proposalInstruction = plan
        ? approvedSupportInstruction({
            diagnosisInstruction: supportProposal.instruction,
            planSummary: assistantContent,
            plan: planWithIntent,
          })
        : null;
      const proposalReady =
        completedTerminal?.outcome === "plan_succeeded" &&
        proposalInstruction !== null &&
        (await supportMutationStillAuthorized({
          sessionId: supportProposal.sessionId,
          projectId: project.id,
        }));
      const [updatedSession] = await db
        .update(supportZeroSessionsTable)
        .set({
          status: proposalReady ? "proposal_ready" : "interrupted",
          proposal: proposalReady
            ? {
                diagnosisInstruction: supportProposal.instruction,
                instruction: proposalInstruction,
                summary: assistantContent,
                plan: planWithIntent,
                planMessageId: assistantMessage.id,
                requiresOwnerApproval: true,
              }
            : {
                diagnosisInstruction: supportProposal.instruction,
                summary: "Zero could not prepare a proposal. Nothing was changed.",
                requiresOwnerApproval: true,
              },
          terminal: completedTerminal as unknown as Record<string, unknown>,
          completedAt: proposalReady ? null : new Date(),
        })
        .where(
          and(
            eq(supportZeroSessionsTable.id, supportProposal.sessionId),
            eq(supportZeroSessionsTable.status, "diagnosing"),
            eq(supportZeroSessionsTable.taskId, completedTerminal?.taskId ?? -1),
          ),
        )
        .returning({ id: supportZeroSessionsTable.id });
      if (!updatedSession) {
        res.status(409).json({
          error:
            "This support proposal ended before its result could be recorded. Nothing was changed.",
          code: "support_proposal_terminal_unavailable",
        });
        return;
      }
      await recordSupportGrantEvent({
        grantId: supportProposal.grantId,
        ticketId: supportProposal.ticketId,
        projectId: supportProposal.projectId,
        actorUserId: supportProposal.staffUserId,
        event: proposalReady ? "zero_proposal_ready" : "zero_proposal_interrupted",
        detail: {
          supportSessionId: supportProposal.sessionId,
          taskId: completedTerminal?.taskId ?? null,
          proposalMessageId: proposalReady ? assistantMessage.id : null,
        },
      });
      if (proposalReady) {
        const [ownerIdentity, staffIdentity] = await Promise.all([
          getSharedAccountProfile(supportProposal.ownerUserId),
          getSharedAccountProfile(supportProposal.staffUserId),
        ]);
        const staffName = staffIdentity?.displayName ?? "NabuFlow Support";
        const summary = assistantContent.slice(0, 2_000);
        const email = supportProposalReadyTemplate({
          ticketId: supportProposal.ticketId,
          projectName: project.name,
          staffName,
          summary,
          decisionUrl: supportProductUrl(`/support/tickets/${supportProposal.ticketId}`),
        });
        await deliverSupportConsequence({
          ticketId: supportProposal.ticketId,
          projectId: project.id,
          recipientUserId: supportProposal.ownerUserId,
          recipientEmail: ownerIdentity?.email ?? null,
          actorUserId: supportProposal.staffUserId,
          actorName: staffName,
          kind: "proposal_ready",
          notification: {
            type: "support_proposal_ready",
            title: "Zero's support proposal is ready for your review",
            body: `${project.name}: nothing changes until you approve or decline.`,
            metadata: { supportSessionId: supportProposal.sessionId },
          },
          email,
        });
      }
    }

    await db
      .update(projectsTable)
      .set({
        updatedAt: sql`now()`,
        lastTaskSummary: content.slice(0, 140),
        lastTaskSummaryProvenance: projectSummaryProvenance({
          sourceKind: "message",
          sourceIdentity: `message:${userMessage.id}`,
          messageId: userMessage.id,
          actorUserId: req.userId ?? project.ownerId,
          content: content.slice(0, 140),
        }),
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
  },
);

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
 * SSE endpoint for answer, clarify, and observe messages.
 * Streams OpenAI tokens word-by-word so the UI feels instant.
 *
 * Event types emitted:
 *   {"type":"session","streamSessionId":"…"}  — first event; use for reconnect/resume
 *   {"type":"intent","intent":"answer"|"clarify"|"observe","receiptId":N}
 *   {"type":"token","content":"…"}   — incremental text chunk
 *   {"type":"done","userMessageId":N,"assistantMessageId":N,"plan":{…}}  — stream complete
 *   {"type":"fallback","intent":"mutate"|"plan"}  — regular endpoint owns execution;
 *                                                    the client should
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
    const authoritativeExplicitAgentIntent = isZeroProjectChoiceCaptureOnlyMessage(content)
      ? "answer"
      : explicitAgentIntent;
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

    // Keep streaming/converse requests on the same primary-artifact boundary as
    // planning, support proposals, and trusted builds.
    const currentProjectFiles = await loadPrimaryArtifactFiles(project.id);

    const [recentMessages, summaryEntry, projectChoices, memoryTruth] = await Promise.all([
      db
        .select({ role: chatMessagesTable.role, content: chatMessagesTable.content })
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
      loadZeroProjectChoices(project.id),
      readZeroProjectMemoryTruth(project.id),
    ]);

    const projectMemoryContext = zeroProjectMemoryContext({
      projectId: project.id,
      projectName: project.name,
      description: project.description,
      summary: project.summary,
      lastTaskSummary: project.lastTaskSummary,
      conversationSummary: summaryEntry[0]?.content,
      choices: projectChoices,
      reconciliation: memoryTruth,
    });

    const conversationHistory: ConversationTurn[] = recentMessages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
      .slice(-8);

    let classifiedForReceipt: IntentResult | null = null;
    const classify = async (): Promise<IntentResult> => {
      classifiedForReceipt ??= await runIntentClassifierPipeline(
        content,
        conversationHistory,
        currentProjectFiles.length > 0,
      );
      return classifiedForReceipt;
    };
    let intentReceipt: IntentReceipt;
    try {
      intentReceipt = await persistAuthoritativeIntent({
        projectId: project.id,
        requestId: streamIdempotencyKey ?? randomUUID(),
        legacyIntent: () =>
          authoritativeExplicitAgentIntent
            ? authoritativeExplicitAgentIntent
            : planMode
              ? "plan"
              : (classifiedForReceipt?.legacyIntent ?? "converse"),
        explicitControl: authoritativeExplicitAgentIntent as ZeroIntentExplicitControl | undefined,
        planMode: Boolean(planMode),
        approvedPlanStep: false,
        imageGenerationRequested: false,
        attachments,
        conversationTurnCount: conversationHistory.length,
        fileCount: currentProjectFiles.length,
        classify,
      });
    } catch (error) {
      if (streamIdempotencyKey) idempotencyStore.delete(streamIdempotencyKey);
      logger.error(
        { projectId: project.id, errorType: error instanceof Error ? error.name : "UnknownError" },
        "zero-intent authoritative stream receipt unavailable",
      );
      res.status(503).json({
        error: "I couldn't safely determine what to do with that request. Please try again.",
        code: "intent_receipt_unavailable",
      });
      return;
    }
    const resolvedIntent = intentReceipt.intent;
    const terminalIntentReceiptId = intentReceipt.receiptId;

    // The receipt is authoritative before any route dispatch. Planning and mutation
    // requests fall back to the regular endpoint, which reuses this exact receipt.
    if (resolvedIntent === "plan" || resolvedIntent === "mutate") {
      if (streamIdempotencyKey) idempotencyStore.delete(streamIdempotencyKey);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      res.write(`data: ${JSON.stringify({ type: "fallback", intent: resolvedIntent })}\n\n`);
      res.end();
      return;
    }

    const converseOwner = req.userId ?? project.ownerId;
    if (converseOwner) {
      const deduction = await deductCreditsAtomic(converseOwner, 1, {
        type: "converse",
        description: `${resolvedIntent === "observe" ? "Project observation" : resolvedIntent === "clarify" ? "Clarifying question" : "Assistant chat"} — project ${project.id}`,
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

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const abortController = new AbortController();
    req.on("close", () => {
      abortController.abort();
    });

    const { sessionId: streamSessionId, session: streamSession } = createStreamSession();
    const sendEvent = (data: Record<string, unknown>): void => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    sendEvent({ type: "session", streamSessionId });
    sendEvent({
      type: "intent",
      intent: resolvedIntent,
      receiptId: intentReceipt.receiptId,
    });

    const effectivePlanMode = false;
    const isAmbiguous = resolvedIntent === "clarify";

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
          intentReceiptId: intentReceipt.receiptId,
        })
        .returning();
      if (!userMessage) throw new Error("Failed to save user message");
      userMessageId = userMessage.id;
      try {
        await intentReceiptStore.linkMessage(intentReceipt.receiptId, userMessage.id);
      } catch (error) {
        logger.warn(
          {
            projectId: project.id,
            errorType: error instanceof Error ? error.name : "UnknownError",
          },
          "zero-intent authoritative stream message link unavailable",
        );
      }
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
        status: "answering",
        prompt: content,
        agentIdentity: "main",
        origin: streamMessageOrigin,
        intentReceiptId: terminalIntentReceiptId,
        hasBrainstormContext: streamHasBrainstormContext,
        brainstormTurnCount: streamHasBrainstormContext
          ? (streamBrainstormContext as Array<{ role: string; content: string }>).length
          : null,
      })
      .returning();

    if (converseTask) {
      await governIntentAdmission({
        phase: "creator",
        projectId: project.id,
        taskId: converseTask.id,
        requestId: intentReceipt.requestId,
        mutationCapable: false,
        receipt: intentReceipt,
      });
    }

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
        const dataUri = await fetchAttachmentAsDataUri(att.url, project.id);
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
          conversationSummary: projectMemoryContext,
          taskId: converseTask?.id,
        },
        (token) => {
          streamSession.tokens.push(token);
          streamSession.emitter.emit("token");
          sendEvent({ type: "token", content: token });
        },
      );

      // Pipeline resolved — stop keep-alive pings
      stopKeepAlive();

      // A disconnect is a durable interrupted outcome; never close a stream
      // without the same terminal evidence that the task row carries.
      if (abortController.signal.aborted) {
        let terminal: ZeroTerminalV1 | null = null;
        if (converseTask) {
          ({ terminal } = await persistInterruptedZeroTerminal({
            taskId: converseTask.id,
            intent: resolvedIntent,
            intentReceiptId: terminalIntentReceiptId,
            cause: "client_disconnect",
            evidence: { lastPhase: "response_stream", changedPaths: [] },
            allowedStatuses: ["answering"],
          }));
        }
        streamSession.complete = true;
        streamSession.donePayload = { terminal };
        streamSession.emitter.emit("done");
        res.end();
        return;
      }

      // Build the plan payload
      let plan: Record<string, unknown>;
      if (converseResult.clarifying) {
        plan = {
          kind: "clarifying",
          question: converseResult.clarifying.question,
          options: converseResult.clarifying.options,
          taskId,
          intent: resolvedIntent,
        };
      } else {
        plan = {
          kind: "converse",
          taskId,
          intent: resolvedIntent,
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

      const terminal = converseTask
        ? responseSucceededTerminal({
            schema: "zero-terminal-v1",
            taskId: converseTask.id,
            intent: resolvedIntent,
            intentReceiptId: terminalIntentReceiptId,
            completedAt: new Date().toISOString(),
            outcome: "response_succeeded",
            runStatus: "completed",
            evidence: {
              assistantMessageId: assistantMessage.id,
              stopEvidence: converseResult.stopEvidence,
            },
          })
        : null;
      if (terminal) {
        const persisted = await persistZeroTerminal({ terminal, allowedStatuses: ["answering"] });
        if (!persisted) throw new Error("The response outcome could not be recorded");
        plan = { ...plan, terminalRef: zeroTerminalRef(terminal) };
        await db
          .update(chatMessagesTable)
          .set({ plan })
          .where(eq(chatMessagesTable.id, assistantMessage.id));
      }

      rememberCompletedAgentTask({
        projectId: project.id,
        userId: req.userId ?? project.ownerId,
        taskId,
        intent: resolvedIntent,
        userPrompt: content,
        assistantSummary: converseResult.markdown,
        category: resolvedIntent === "answer" ? "conversation" : resolvedIntent,
        tags: ["chat", "stream", resolvedIntent],
      });

      // Update project activity timestamp
      await db
        .update(projectsTable)
        .set({
          updatedAt: sql`now()`,
          lastTaskSummary: content.slice(0, 140),
          lastTaskSummaryProvenance: projectSummaryProvenance({
            sourceKind: "message",
            sourceIdentity: `message:${userMessageId}`,
            messageId: userMessageId,
            actorUserId: req.userId ?? project.ownerId,
            content: content.slice(0, 140),
          }),
          agentMode: mode,
        })
        .where(eq(projectsTable.id, project.id));

      const donePayload = {
        userMessageId,
        assistantMessageId: assistantMessage.id,
        plan,
        terminal,
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

      // Client aborts converge on the same durable interrupted terminal.
      if (abortController.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        let terminal: ZeroTerminalV1 | null = null;
        if (converseTask) {
          ({ terminal } = await persistInterruptedZeroTerminal({
            taskId: converseTask.id,
            intent: resolvedIntent,
            intentReceiptId: terminalIntentReceiptId,
            cause: "client_disconnect",
            evidence: { lastPhase: "response_stream", changedPaths: [] },
            allowedStatuses: ["answering"],
          }));
        }
        streamSession.complete = true;
        streamSession.donePayload = { terminal };
        streamSession.emitter.emit("done");
        res.end();
        return;
      }
      // Save a fallback error message to the DB
      try {
        const interruption = err instanceof ConverseCompletionInterruptedError ? err : null;
        const failure = interruption ? null : describeConverseFailure(err);
        const terminal = converseTask
          ? interruption
            ? interruptedTerminal({
                schema: "zero-terminal-v1",
                taskId: converseTask.id,
                intent: resolvedIntent,
                intentReceiptId: terminalIntentReceiptId,
                completedAt: new Date().toISOString(),
                outcome: "interrupted",
                runStatus: "interrupted",
                cause: interruption.code,
                evidence: { lastPhase: "response_stream", changedPaths: [] },
              })
            : failedTerminal({
                schema: "zero-terminal-v1",
                taskId: converseTask.id,
                intent: resolvedIntent,
                intentReceiptId: terminalIntentReceiptId,
                completedAt: new Date().toISOString(),
                outcome: "failed",
                runStatus: "failed",
                cause: {
                  code: failure?.code ?? "conversation_failed",
                  stage: "response_stream",
                },
                evidence: {
                  summary: failure?.message ?? "I wasn't able to answer that request.",
                },
              })
          : null;
        const failureMessage = terminal
          ? presentZeroTerminalV1(terminal).message
          : (failure?.message ?? "I wasn't able to answer that request.");
        const persistedContent = interruption?.partialText.trim() || failureMessage;
        const [errMsg] = await db
          .insert(chatMessagesTable)
          .values({
            projectId: project.id,
            role: "assistant",
            content: persistedContent,
            agentMode: mode,
            planMode: effectivePlanMode,
            plan: {
              kind: interruption ? "interrupted" : "error",
              message: failureMessage,
              intent: resolvedIntent,
              ...(interruption ? { retry: true } : {}),
            },
            origin: streamMessageOrigin,
            intentReceiptId: terminalIntentReceiptId,
          })
          .returning();
        if (terminal) {
          await persistZeroTerminal({ terminal, allowedStatuses: ["answering"] });
          if (errMsg) {
            await db
              .update(chatMessagesTable)
              .set({
                plan: {
                  kind: interruption ? "interrupted" : "error",
                  message: failureMessage,
                  intent: resolvedIntent,
                  ...(interruption ? { retry: true } : {}),
                  terminalRef: zeroTerminalRef(terminal),
                },
              })
              .where(eq(chatMessagesTable.id, errMsg.id));
          }
        }
        const errorPayload = {
          message: failureMessage,
          userMessageId,
          assistantMessageId: errMsg?.id,
          terminal,
        };
        streamSession.complete = true;
        streamSession.errorPayload = errorPayload;
        streamSession.emitter.emit("error");
        sendEvent({ type: "error", ...errorPayload });
      } catch {
        const errorPayload = { message: "I wasn't able to answer that request.", userMessageId };
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
