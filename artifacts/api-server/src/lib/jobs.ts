import { eq, sql, and, inArray, desc, or, asc } from "drizzle-orm";
import {
  db,
  projectsTable,
  agentTasksTable,
  projectFilesTable,
  projectVersionsTable,
  chatMessagesTable,
  taskEventsTable,
  knowledgeEntriesTable,
  secretsTable,
  deploymentLogsTable,
  buildAnalyticsTable,
  type TaskReport,
  type FileSnapshotEntry,
} from "@workspace/db";
import {
  runBuildPipeline,
  runRefinePipeline,
  runMobileBuildPipeline,
  runMobileRefinePipeline,
  scanCodeSmells,
  sanitisePrompt,
  scanForSecrets,
  validateCrossFileConsistency,
  type BuilderFile,
  type ConversationTurn,
} from "./builder";
import { openai } from "@workspace/integrations-openai-ai-server";
import type { AgentMode } from "./ai";
import { logger } from "./logger";
import { writeKnowledge } from "./knowledge";
import type { DiffSummary } from "@workspace/db";
import { getOrCreateCredits, deductCredits } from "../routes/credits";
import { extractPageMap } from "./page-map";
import { publishTaskEvent } from "./event-bus";
import {
  triggerEasBuild,
  getEasBuildStatus,
  triggerEasSubmit,
  mapEasStatusToDeploymentStatus,
  type EasPlatform,
} from "./eas";

/** Credit cost per AI call, keyed by agentMode. */
const CREDIT_COST: Record<string, number> = {
  lite: 1,
  eco: 2,
  power: 5,
  pro: 10,
};

/** OpenAI model per agent mode — kept in sync with builder.ts for analytics recording. */
const MODEL_FOR_MODE: Record<AgentMode, string> = {
  lite: "gpt-5-nano",
  eco: "gpt-5-mini",
  power: "gpt-5.4",
  pro: "gpt-5.4",
};

/**
 * Auto-escalation: if correction pass fails, retry at the next model tier.
 * Capped at one level to avoid runaway credit consumption.
 * power/pro both use the same model so escalation stops there.
 */
const ESCALATION_MAP: Partial<Record<AgentMode, AgentMode>> = {
  lite: "eco",
  eco: "power",
};

export type JobKind = "build" | "refine";

export interface JobInput {
  taskId: number;
  projectId: number;
  kind: JobKind;
  userPrompt: string;
  agentMode: AgentMode;
  conversationHistory?: ConversationTurn[];
  queueBatchId?: string | null;
  queueIndex?: number | null;
  queueTotalCount?: number | null;
}

async function emitEvent(
  taskId: number,
  eventType: string,
  message: string,
  filePath?: string,
): Promise<void> {
  try {
    const [row] = await db
      .insert(taskEventsTable)
      .values({
        taskId,
        eventType,
        message,
        filePath: filePath ?? null,
      })
      .returning();
    if (row) {
      publishTaskEvent({
        id: row.id,
        taskId: row.taskId,
        eventType: row.eventType,
        message: row.message,
        filePath: row.filePath ?? null,
        createdAt: row.createdAt,
      });
    }
  } catch (err) {
    logger.warn({ err, taskId, eventType }, "Failed to emit task event");
  }
}

async function loadFiles(projectId: number): Promise<BuilderFile[]> {
  const rows = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));
  return rows.map((r) => ({
    path: r.path,
    content: r.content,
    mimeType: r.mimeType,
  }));
}

async function snapshotFilesForVersion(projectId: number): Promise<FileSnapshotEntry[]> {
  const rows = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));
  return rows.map((r) => ({
    path: r.path,
    content: r.content,
    mimeType: r.mimeType,
  }));
}

/**
 * Bulk-safe file writer. For replaceAll (initial build): one DELETE + one bulk INSERT.
 * For refine (replaceAll=false): one DELETE of affected paths + one bulk INSERT.
 * Eliminates the N+1 per-file loop.
 */
async function writeFiles(
  projectId: number,
  files: BuilderFile[],
  replaceAll: boolean,
): Promise<void> {
  if (replaceAll) {
    await db.delete(projectFilesTable).where(eq(projectFilesTable.projectId, projectId));
  } else if (files.length > 0) {
    await db.delete(projectFilesTable).where(
      and(
        eq(projectFilesTable.projectId, projectId),
        inArray(
          projectFilesTable.path,
          files.map((f) => f.path),
        ),
      ),
    );
  }
  if (files.length > 0) {
    await db.insert(projectFilesTable).values(
      files.map((f) => ({
        projectId,
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
      })),
    );
  }
}

/**
 * Bulk-safe file deleter — one DELETE with inArray instead of N individual deletes.
 */
async function deleteFiles(projectId: number, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await db
    .delete(projectFilesTable)
    .where(and(eq(projectFilesTable.projectId, projectId), inArray(projectFilesTable.path, paths)));
}

/** Map of integration name → required secret key names (subset of the frontend registry). */
const INTEGRATION_KEY_MAP: Array<{ name: string; keys: string[] }> = [
  { name: "OpenAI", keys: ["OPENAI_API_KEY"] },
  { name: "Anthropic", keys: ["ANTHROPIC_API_KEY"] },
  { name: "Gemini", keys: ["GEMINI_API_KEY"] },
  { name: "Clerk", keys: ["CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"] },
  { name: "Auth0", keys: ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET"] },
  { name: "Supabase Auth", keys: ["SUPABASE_URL", "SUPABASE_ANON_KEY"] },
  {
    name: "Firebase Auth",
    keys: ["FIREBASE_API_KEY", "FIREBASE_AUTH_DOMAIN", "FIREBASE_PROJECT_ID"],
  },
  { name: "PostgreSQL / Neon", keys: ["DATABASE_URL"] },
  { name: "Supabase", keys: ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_KEY"] },
  { name: "Firebase Firestore", keys: ["FIREBASE_PROJECT_ID", "FIREBASE_API_KEY"] },
  {
    name: "AWS S3",
    keys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_S3_BUCKET", "AWS_REGION"],
  },
  {
    name: "Cloudflare R2",
    keys: ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_ACCOUNT_ID"],
  },
  { name: "Supabase Storage", keys: ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"] },
  {
    name: "Stripe",
    keys: ["STRIPE_PUBLISHABLE_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  },
  {
    name: "Stripe Connect",
    keys: ["STRIPE_PUBLISHABLE_KEY", "STRIPE_SECRET_KEY", "STRIPE_CONNECT_CLIENT_ID"],
  },
  { name: "Google Maps", keys: ["GOOGLE_MAPS_API_KEY"] },
  {
    name: "Apple Maps",
    keys: ["APPLE_MAPS_KEY_ID", "APPLE_MAPS_TEAM_ID", "APPLE_MAPS_PRIVATE_KEY"],
  },
  { name: "Mapbox", keys: ["MAPBOX_PUBLIC_TOKEN"] },
  { name: "Resend", keys: ["RESEND_API_KEY"] },
  { name: "SendGrid", keys: ["SENDGRID_API_KEY"] },
  { name: "Mailgun", keys: ["MAILGUN_API_KEY", "MAILGUN_DOMAIN"] },
  { name: "Twilio", keys: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"] },
  { name: "Firebase Cloud Messaging", keys: ["FIREBASE_PROJECT_ID", "FIREBASE_SERVER_KEY"] },
  { name: "PostHog", keys: ["POSTHOG_API_KEY", "POSTHOG_HOST"] },
  { name: "Sentry", keys: ["SENTRY_DSN"] },
  { name: "Google Analytics", keys: ["GA_MEASUREMENT_ID"] },
  { name: "GitHub", keys: ["GITHUB_TOKEN"] },
  { name: "Vercel", keys: ["VERCEL_TOKEN"] },
  { name: "Render", keys: ["RENDER_API_KEY"] },
  { name: "Fly.io", keys: ["FLY_API_TOKEN"] },
  { name: "Railway", keys: ["RAILWAY_API_TOKEN"] },
];

async function loadActiveIntegrations(projectId: number): Promise<string> {
  try {
    const rows = await db
      .select({ name: secretsTable.name, verificationStatus: secretsTable.verificationStatus })
      .from(secretsTable)
      .where(eq(secretsTable.projectId, projectId));
    const secretMap = new Map(rows.map((r) => [r.name, r.verificationStatus ?? "unverified"]));
    const active = INTEGRATION_KEY_MAP.filter((integration) =>
      integration.keys.every((k) => secretMap.has(k) && secretMap.get(k) === "verified"),
    ).map((i) => i.name);
    const partial = INTEGRATION_KEY_MAP.filter((integration) => {
      const isActive = active.includes(integration.name);
      if (isActive) return false;
      const somePresent = integration.keys.some((k) => secretMap.has(k));
      return somePresent;
    }).map((i) => i.name);
    const parts: string[] = [];
    if (active.length > 0) {
      parts.push(
        `ACTIVE INTEGRATIONS (connected and verified): ${active.join(", ")}. When generating or refining code, prefer these services over alternatives and reference their environment variables from project secrets.`,
      );
    }
    if (partial.length > 0) {
      parts.push(
        `PARTIALLY CONFIGURED (keys present but not yet verified): ${partial.join(", ")}. These may work but have not been verified — mention them if the user asks.`,
      );
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}

type KnowledgeContextResult = {
  context: string;
  applied: Array<{ title: string; category: string }>;
};

/**
 * Compute a diff summary for an initial build (previous = empty).
 */
function computeBuildDiff(newFiles: BuilderFile[]): DiffSummary {
  const filesAdded = newFiles.map((f) => f.path);
  const linesAdded = newFiles.reduce((sum, f) => sum + f.content.split("\n").length, 0);
  return { filesAdded, filesModified: [], filesRemoved: [], linesAdded, linesRemoved: 0 };
}

/**
 * Compute a diff summary for a refine operation from the existing file set.
 */
function computeRefineDiff(
  existingFiles: BuilderFile[],
  changedFiles: BuilderFile[],
  removedPaths: string[],
): DiffSummary {
  const prevMap = new Map(existingFiles.map((f) => [f.path, f.content]));
  const filesAdded: string[] = [];
  const filesModified: string[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const f of changedFiles) {
    if (!prevMap.has(f.path)) {
      filesAdded.push(f.path);
      linesAdded += f.content.split("\n").length;
    } else if (prevMap.get(f.path) !== f.content) {
      filesModified.push(f.path);
      const newLines = f.content.split("\n").length;
      const prevLines = (prevMap.get(f.path) ?? "").split("\n").length;
      linesAdded += Math.max(0, newLines - prevLines);
      linesRemoved += Math.max(0, prevLines - newLines);
    }
  }

  for (const path of removedPaths) {
    linesRemoved += (prevMap.get(path) ?? "").split("\n").length;
  }

  return { filesAdded, filesModified, filesRemoved: removedPaths, linesAdded, linesRemoved };
}

/**
 * Tokenise a string into a set of meaningful lowercase words (≥3 chars).
 */
function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s,.:;_\-/()[\]{}'"!?]+/)
      .filter((w) => w.length >= 3),
  );
}

/**
 * Relevance-ranked knowledge injection.
 * Scores each knowledge entry by keyword overlap with the current user prompt,
 * then returns the top 15 most relevant. Also loads active integrations context.
 * Returns both the combined context string and the selected knowledge entries
 * so they can be surfaced in the task report.
 */
async function loadKnowledgeContext(
  projectId: number,
  userPrompt?: string,
): Promise<KnowledgeContextResult> {
  try {
    const [entries, integrationsNote] = await Promise.all([
      db
        .select()
        .from(knowledgeEntriesTable)
        .where(
          or(
            eq(knowledgeEntriesTable.approvedForReuse, true),
            eq(knowledgeEntriesTable.projectId, projectId),
          ),
        )
        .orderBy(desc(knowledgeEntriesTable.createdAt))
        .limit(80),
      loadActiveIntegrations(projectId),
    ]);

    let topEntries: typeof entries;

    if (entries.length === 0) {
      return { context: integrationsNote, applied: [] };
    }

    const APPROVED_BOOST = 1.5;
    if (userPrompt && userPrompt.length > 0) {
      const promptTokens = tokenise(userPrompt);
      const N = entries.length;

      // Compute document frequency (df) for each query token across all entries
      const df = new Map<string, number>();
      for (const t of promptTokens) {
        let count = 0;
        for (const e of entries) {
          if (tokenise(`${e.title} ${e.content} ${e.tags ?? ""}`).has(t)) count++;
        }
        df.set(t, count);
      }

      const scored = entries.map((e) => {
        const entryText = `${e.title} ${e.content} ${e.tags ?? ""}`;
        const entryWords = entryText.toLowerCase().split(/\W+/).filter(Boolean);
        const termCounts = new Map<string, number>();
        for (const w of entryWords) {
          termCounts.set(w, (termCounts.get(w) ?? 0) + 1);
        }
        const entryTokens = new Set(termCounts.keys());

        // TF-IDF: sum of tf(t, entry) × idf(t) for each query token present in entry
        let score = 0;
        for (const t of promptTokens) {
          if (entryTokens.has(t)) {
            const tf = (termCounts.get(t) ?? 0) / Math.max(entryWords.length, 1);
            const idf = Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) + 1;
            score += tf * idf;
          }
        }

        // Boost entries approved for reuse — higher-quality vetted lessons
        if (e.approvedForReuse) score *= APPROVED_BOOST;
        return { entry: e, score };
      });
      scored.sort((a, b) => b.score - a.score);
      topEntries = scored.slice(0, 8).map((s) => s.entry);
    } else {
      // When no prompt provided, prefer approvedForReuse entries first
      topEntries = [...entries]
        .sort((a, b) => (b.approvedForReuse ? 1 : 0) - (a.approvedForReuse ? 1 : 0))
        .slice(0, 8);
    }

    const knowledgePart = topEntries
      .map((e) => `[${e.category}] ${e.title}: ${e.content}`)
      .join("\n");
    const context = [integrationsNote, knowledgePart].filter(Boolean).join("\n\n");
    const applied = topEntries.map((e) => ({ title: e.title, category: e.category }));

    return { context, applied };
  } catch {
    return { context: "", applied: [] };
  }
}

/**
 * Look up the most recent plan-mode assistant message for this project and return
 * its plan JSON to store as a version annotation (planSnapshot).
 */
async function loadLatestPlanSnapshot(projectId: number): Promise<Record<string, unknown> | null> {
  try {
    const [row] = await db
      .select({ plan: chatMessagesTable.plan })
      .from(chatMessagesTable)
      .where(
        and(
          eq(chatMessagesTable.projectId, projectId),
          eq(chatMessagesTable.planMode, true),
          eq(chatMessagesTable.role, "assistant"),
        ),
      )
      .orderBy(desc(chatMessagesTable.createdAt))
      .limit(1);
    if (!row?.plan || typeof row.plan !== "object") return null;
    // Exclude error plans
    if ((row.plan as Record<string, unknown>).kind === "error") return null;
    return row.plan as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function generateFixSuggestions(userPrompt: string, errorMessage: string): Promise<string[]> {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 600,
      messages: [
        {
          role: "system",
          content:
            'You help debug AI-generated web app builds. Given a user request and a build error, return a JSON object with a "suggestions" array of exactly 3 short, specific, actionable fixes the user can try. Each suggestion must be 1 sentence and start with an action verb. Output ONLY valid JSON: {"suggestions":["...","...","..."]}',
        },
        {
          role: "user",
          content: `User request: "${userPrompt}"\n\nBuild error: ${errorMessage}`,
        },
      ],
      response_format: { type: "json_object" },
    });
    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { suggestions?: string[] };
    if (Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
      return parsed.suggestions.slice(0, 3);
    }
  } catch (err) {
    logger.warn({ err }, "Failed to generate fix suggestions");
  }
  return [
    "Simplify the request and try rebuilding with fewer features.",
    "Use Plan Mode first to outline the approach before building.",
    "Check that all required integrations and secrets are configured.",
  ];
}

async function autoWriteFailureLesson(
  userPrompt: string,
  errorMessage: string,
  projectId: number,
  userId?: string,
): Promise<void> {
  await writeKnowledge({
    title: `Build failed: "${userPrompt.slice(0, 60)}"`,
    category: "diagnostic",
    content: `Attempt failed with error: ${errorMessage.slice(0, 300)}. Review the fix suggestions and adjust the approach before retrying.`,
    type: "build",
    severity: "error",
    projectId,
    userId,
  });
}

/**
 * Checks whether warnings from the current build also appeared in recent prior builds.
 * If so, writes a "recurring warning" escalation entry to the Knowledge Vault so the AI
 * can proactively avoid the pattern in future builds.
 */
async function maybeEscalateWarnings(projectId: number, currentWarnings: string[]): Promise<void> {
  if (currentWarnings.length === 0) return;
  try {
    const prevTasks = await db
      .select({ report: agentTasksTable.report })
      .from(agentTasksTable)
      .where(and(eq(agentTasksTable.projectId, projectId), eq(agentTasksTable.status, "completed")))
      .orderBy(desc(agentTasksTable.createdAt))
      .limit(3);

    const prevWarnings = prevTasks.flatMap((t) => t.report?.warnings ?? []);
    const repeated = currentWarnings.filter((w) =>
      prevWarnings.some((pw) => pw.slice(0, 50) === w.slice(0, 50)),
    );

    if (repeated.length > 0) {
      await writeKnowledge({
        title: `Recurring warning: "${repeated[0]!.slice(0, 60)}"`,
        category: "lesson",
        content: `This warning has appeared across multiple builds for project ${projectId}: ${repeated.join("; ")}. Proactively address it in future builds.`,
        type: "refine",
        severity: "warning",
        projectId,
      });
      logger.info({ projectId, repeated }, "Escalated recurring warning to Knowledge Vault");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to escalate repeated warnings");
  }
}

async function drainNextBatchTask(completedTaskId: number): Promise<void> {
  const [completedTask] = await db
    .select()
    .from(agentTasksTable)
    .where(eq(agentTasksTable.id, completedTaskId));
  if (!completedTask?.queueBatchId) return;

  const [nextTask] = await db
    .select()
    .from(agentTasksTable)
    .where(
      and(
        eq(agentTasksTable.queueBatchId, completedTask.queueBatchId),
        eq(agentTasksTable.status, "queued"),
      ),
    )
    .orderBy(asc(agentTasksTable.queueIndex))
    .limit(1);

  if (!nextTask) return;

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, completedTask.projectId));
  if (!project) return;

  const recentMessages = await db
    .select({ role: chatMessagesTable.role, content: chatMessagesTable.content })
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.projectId, completedTask.projectId))
    .orderBy(asc(chatMessagesTable.createdAt));

  const conversationHistory: ConversationTurn[] = recentMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
    .slice(-8);

  const batchTasks = await db
    .select({ id: agentTasksTable.id })
    .from(agentTasksTable)
    .where(eq(agentTasksTable.queueBatchId, completedTask.queueBatchId));

  enqueueJob({
    taskId: nextTask.id,
    projectId: completedTask.projectId,
    kind: "refine",
    userPrompt: nextTask.prompt ?? "",
    agentMode: (project.agentMode as AgentMode) ?? "power",
    conversationHistory,
    queueBatchId: completedTask.queueBatchId,
    queueIndex: nextTask.queueIndex ?? undefined,
    queueTotalCount: batchTasks.length,
  });
}

async function cancelRemainingBatchTasks(failedTaskId: number): Promise<void> {
  const [failedTask] = await db
    .select({ queueBatchId: agentTasksTable.queueBatchId, projectId: agentTasksTable.projectId })
    .from(agentTasksTable)
    .where(eq(agentTasksTable.id, failedTaskId));
  if (!failedTask?.queueBatchId) return;

  try {
    await db
      .update(agentTasksTable)
      .set({ status: "canceled", completedAt: sql`now()` })
      .where(
        and(
          eq(agentTasksTable.queueBatchId, failedTask.queueBatchId),
          eq(agentTasksTable.status, "queued"),
        ),
      );
    logger.info(
      { queueBatchId: failedTask.queueBatchId },
      "Cancelled remaining batch tasks after failure",
    );
  } catch (err) {
    logger.warn({ err }, "Failed to cancel remaining batch tasks");
  }
}

export async function runJob(input: JobInput): Promise<void> {
  const { taskId, projectId, kind, conversationHistory, queueBatchId, queueIndex, queueTotalCount } = input;
  let { userPrompt, agentMode } = input;

  const jobStartTime = Date.now();
  let wasEscalated = false;
  let analyticsErrorCategory: string | null = null;
  let analyticsCorrectionPasses = 0;
  let analyticsOutcome: "success" | "failed" = "failed";

  // Sanitise prompt before injecting into AI context — strip injection patterns
  const { cleaned: sanitisedPrompt, wasModified: promptWasModified } = sanitisePrompt(userPrompt);
  if (promptWasModified) {
    logger.warn({ taskId, projectId }, "Prompt injection patterns detected and stripped from user prompt");
    userPrompt = sanitisedPrompt;
  }

  await emitEvent(taskId, "queued", "Task received, starting pipeline…");

  await db
    .update(agentTasksTable)
    .set({ status: kind === "build" ? "building" : "planning" })
    .where(eq(agentTasksTable.id, taskId));

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) {
    await emitEvent(taskId, "failed", "Project not found.");
    await db
      .update(agentTasksTable)
      .set({
        status: "failed",
        result: "Project not found",
        completedAt: sql`now()`,
      })
      .where(eq(agentTasksTable.id, taskId));
    return;
  }

  const { context: knowledgeContext, applied: knowledgeApplied } = await loadKnowledgeContext(
    projectId,
    userPrompt,
  );

  // --- Credit pre-flight: fail fast if user cannot afford this AI call ---
  const creditCost = CREDIT_COST[agentMode] ?? 1;
  if (project.ownerId) {
    const credits = await getOrCreateCredits(project.ownerId);
    if (credits.balance < creditCost) {
      const msg = `Insufficient credits. This ${agentMode} build costs ${creditCost} credit(s) but your balance is ${credits.balance}. Top up in Billing to continue.`;
      await emitEvent(taskId, "failed", msg);
      await db
        .update(agentTasksTable)
        .set({ status: "failed", result: msg, completedAt: sql`now()` })
        .where(eq(agentTasksTable.id, taskId));
      return;
    }
  }

  try {
    let report: TaskReport;
    let assistantSummary: string;
    let nextVersionLabel: string;
    let diffSummary: DiffSummary | undefined;
    let filesToSmellScan: BuilderFile[] = [];

    const isMobileProject = ["mobile-ios", "mobile-android", "mobile-cross"].includes(project.kind);

    // For mobile projects: load last successful task's wired modules + project secret names once,
    // so both build and refine pipelines have durable module context.
    let activeModuleIds: string[] = [];
    let configuredSecretNames: string[] = [];
    if (isMobileProject) {
      const [lastTask, projectSecrets] = await Promise.all([
        db
          .select({ report: agentTasksTable.report })
          .from(agentTasksTable)
          .where(
            and(eq(agentTasksTable.projectId, projectId), eq(agentTasksTable.status, "completed")),
          )
          .orderBy(desc(agentTasksTable.completedAt))
          .limit(1),
        db
          .select({ name: secretsTable.name })
          .from(secretsTable)
          .where(eq(secretsTable.projectId, projectId)),
      ]);
      const lastReport = lastTask[0]?.report as TaskReport | null;
      activeModuleIds = lastReport?.modulesWired?.map((m) => m.id) ?? [];
      configuredSecretNames = projectSecrets.map((s) => s.name);
    }

    if (kind === "build") {
      await emitEvent(taskId, "planning", "Reading project configuration…");
      await emitEvent(
        taskId,
        "generating_code",
        isMobileProject
          ? "Generating Expo/React Native app with AI…"
          : "Generating app blueprint and code with AI…",
      );

      let result = isMobileProject
        ? await runMobileBuildPipeline({
            projectName: project.name,
            projectKind: project.kind,
            userPrompt,
            agentMode,
            conversationHistory,
            knowledgeContext: knowledgeContext || undefined,
            activeModuleIds,
            configuredSecretNames,
            onEvent: async (type, message) => emitEvent(taskId, type, message),
          })
        : await runBuildPipeline({
            projectName: project.name,
            projectKind: project.kind,
            userPrompt,
            agentMode,
            conversationHistory,
            knowledgeContext: knowledgeContext || undefined,
          });

      analyticsCorrectionPasses = result.correctionPasses;
      analyticsErrorCategory = result.primaryErrorCategory;

      // Auto-escalation: if correction pass failed, retry at next model tier
      const buildEscalationMode = ESCALATION_MAP[agentMode];
      if (result.correctionFailed && buildEscalationMode && !isMobileProject) {
        logger.info({ taskId, projectId, from: agentMode, to: buildEscalationMode }, "Auto-escalating build to higher model tier");
        await emitEvent(taskId, "generating_code", `Validation failed — escalating to ${buildEscalationMode} mode and retrying…`);
        const escalatedResult = await runBuildPipeline({
          projectName: project.name,
          projectKind: project.kind,
          userPrompt,
          agentMode: buildEscalationMode,
          conversationHistory,
          knowledgeContext: knowledgeContext || undefined,
        });
        wasEscalated = true;
        agentMode = buildEscalationMode;
        result = escalatedResult;
        analyticsCorrectionPasses += escalatedResult.correctionPasses;
        analyticsErrorCategory = escalatedResult.primaryErrorCategory ?? analyticsErrorCategory;
        result.report.warnings = [
          `Auto-escalated from ${input.agentMode} to ${buildEscalationMode} mode after validation failure`,
          ...(result.report.warnings ?? []),
        ];
      }

      // Secrets scan — redact before persisting
      const { files: sanitisedFiles, findings: secretFindings } = scanForSecrets(result.files);
      if (secretFindings.length > 0) {
        logger.warn({ taskId, projectId, secretFindings }, "Secrets detected and redacted in generated build files");
        result.report.warnings = [
          ...(result.report.warnings ?? []),
          ...secretFindings.map((f) => `Secrets Scan: ${f.category} detected in ${f.file} and redacted before saving`),
        ];
      }
      result = { ...result, files: sanitisedFiles };

      // Cross-file consistency check
      const buildConsistencyWarnings = validateCrossFileConsistency(sanitisedFiles);
      if (buildConsistencyWarnings.length > 0) {
        result.report.warnings = [...(result.report.warnings ?? []), ...buildConsistencyWarnings];
      }

      await emitEvent(
        taskId,
        "generating_code",
        `Blueprint created: ${result.files.length} file(s) planned.`,
      );

      await emitEvent(taskId, "editing_files", "Writing generated files…");
      for (const f of result.files) {
        await emitEvent(taskId, "editing_files", `Writing ${f.path}`, f.path);
      }
      await writeFiles(projectId, result.files, true);
      diffSummary = computeBuildDiff(result.files);

      report = result.report;
      assistantSummary = result.assistantSummary;
      nextVersionLabel = isMobileProject ? "Initial mobile build" : "Initial build";
      filesToSmellScan = result.files;
    } else {
      await emitEvent(taskId, "reading_files", "Reading current project files…");
      const existingFiles = await loadFiles(projectId);
      await emitEvent(taskId, "reading_files", `Loaded ${existingFiles.length} existing file(s).`);

      await emitEvent(
        taskId,
        "generating_code",
        isMobileProject
          ? "Applying change to Expo project with AI…"
          : "Applying change request with AI…",
      );

      let refineResult = isMobileProject
        ? await runMobileRefinePipeline({
            projectName: project.name,
            projectKind: project.kind,
            userPrompt,
            agentMode,
            existingFiles,
            conversationHistory,
            knowledgeContext: knowledgeContext || undefined,
            activeModuleIds,
            configuredSecretNames,
            onEvent: async (type, message) => emitEvent(taskId, type, message),
          })
        : await runRefinePipeline({
            projectName: project.name,
            projectKind: project.kind,
            userPrompt,
            agentMode,
            existingFiles,
            conversationHistory,
            knowledgeContext: knowledgeContext || undefined,
          });

      analyticsCorrectionPasses = refineResult.correctionPasses;
      analyticsErrorCategory = refineResult.primaryErrorCategory;

      // Auto-escalation: if correction pass failed, retry at next model tier
      const refineEscalationMode = ESCALATION_MAP[agentMode];
      if (refineResult.correctionFailed && refineEscalationMode && !isMobileProject) {
        logger.info({ taskId, projectId, from: agentMode, to: refineEscalationMode }, "Auto-escalating refine to higher model tier");
        await emitEvent(taskId, "generating_code", `Validation failed — escalating to ${refineEscalationMode} mode and retrying…`);
        const escalatedResult = await runRefinePipeline({
          projectName: project.name,
          projectKind: project.kind,
          userPrompt,
          agentMode: refineEscalationMode,
          existingFiles,
          conversationHistory,
          knowledgeContext: knowledgeContext || undefined,
        });
        wasEscalated = true;
        agentMode = refineEscalationMode;
        refineResult = escalatedResult;
        analyticsCorrectionPasses += escalatedResult.correctionPasses;
        analyticsErrorCategory = escalatedResult.primaryErrorCategory ?? analyticsErrorCategory;
        refineResult.report.warnings = [
          `Auto-escalated from ${input.agentMode} to ${refineEscalationMode} mode after validation failure`,
          ...(refineResult.report.warnings ?? []),
        ];
      }

      // Secrets scan — redact before persisting
      const { files: sanitisedChangedFiles, findings: refineSecretFindings } = scanForSecrets(refineResult.changedFiles);
      if (refineSecretFindings.length > 0) {
        logger.warn({ taskId, projectId, refineSecretFindings }, "Secrets detected and redacted in refined files");
        refineResult.report.warnings = [
          ...(refineResult.report.warnings ?? []),
          ...refineSecretFindings.map((f) => `Secrets Scan: ${f.category} detected in ${f.file} and redacted before saving`),
        ];
      }
      refineResult = { ...refineResult, changedFiles: sanitisedChangedFiles };

      // Cross-file consistency check on the merged project file set
      const mergedFilesForConsistency = [...existingFiles];
      for (const cf of refineResult.changedFiles) {
        const idx = mergedFilesForConsistency.findIndex((f) => f.path === cf.path);
        if (idx >= 0) mergedFilesForConsistency[idx] = cf; else mergedFilesForConsistency.push(cf);
      }
      const refineConsistencyWarnings = validateCrossFileConsistency(mergedFilesForConsistency);
      if (refineConsistencyWarnings.length > 0) {
        refineResult.report.warnings = [...(refineResult.report.warnings ?? []), ...refineConsistencyWarnings];
      }

      const result = refineResult;

      await emitEvent(
        taskId,
        "editing_files",
        `AI returned ${result.changedFiles.length} changed file(s).`,
      );

      if (result.changedFiles.length > 0) {
        for (const f of result.changedFiles) {
          await emitEvent(taskId, "editing_files", `Updating ${f.path}`, f.path);
        }
        await writeFiles(projectId, result.changedFiles, false);
      }
      if (result.removedPaths.length > 0) {
        for (const p of result.removedPaths) {
          await emitEvent(taskId, "editing_files", `Removing ${p}`, p);
        }
        await deleteFiles(projectId, result.removedPaths);
      }
      diffSummary = computeRefineDiff(existingFiles, result.changedFiles, result.removedPaths);

      report = result.report;
      assistantSummary = result.assistantSummary;
      nextVersionLabel = userPrompt.slice(0, 40) || "Refinement";
      filesToSmellScan = result.changedFiles;
    }

    // Attach knowledge lessons that influenced this build
    if (knowledgeApplied.length > 0) {
      report.knowledgeApplied = knowledgeApplied;
    }

    await emitEvent(taskId, "saving_version", "Saving version rollback point…");
    const snapshot = await snapshotFilesForVersion(projectId);

    // Fetch the most recent plan snapshot to annotate this version
    const planSnapshot = await loadLatestPlanSnapshot(projectId);

    const [version] = await db
      .insert(projectVersionsTable)
      .values({
        projectId,
        label: nextVersionLabel,
        note: assistantSummary.slice(0, 200),
        filesSnapshot: snapshot,
        planSnapshot: planSnapshot ?? undefined,
      })
      .returning();
    report.versionId = version?.id ?? null;

    await emitEvent(taskId, "updating_preview", "Refreshing preview…");

    await db
      .update(agentTasksTable)
      .set({
        status: "completed",
        result: assistantSummary,
        report,
        completedAt: sql`now()`,
      })
      .where(eq(agentTasksTable.id, taskId));

    // Fire-and-forget code-smell scan — runs after task is already "completed"
    // so it never delays pipeline completion or the user-facing response.
    if (filesToSmellScan.length > 0) {
      setImmediate(() => {
        try {
          const smells = scanCodeSmells(filesToSmellScan);
          if (smells.length > 0) {
            db.update(agentTasksTable)
              .set({ report: { ...report, codeSmells: smells } })
              .where(eq(agentTasksTable.id, taskId))
              .catch((err: unknown) =>
                logger.warn(
                  { err, taskId },
                  "Failed to persist code-smell scan results (non-fatal)",
                ),
              );
          }
        } catch (err) {
          logger.warn({ err, taskId }, "Code-smell scan error (non-fatal)");
        }
      });
    }

    // Update project status and persist the latest summary as the project-level description
    await db
      .update(projectsTable)
      .set({
        status: "testing",
        lastTaskSummary: assistantSummary.slice(0, 140),
        summary: assistantSummary,
        updatedAt: sql`now()`,
      })
      .where(eq(projectsTable.id, projectId));

    // Extract the page map BEFORE emitting "completed" so the
    // "page_map_updated" event is guaranteed to precede the terminal event.
    // This eliminates the race where event consumers stop listening on
    // "completed" and never see the subsequent "page_map_updated".
    try {
      await extractPageMap(projectId);
      await emitEvent(taskId, "page_map_updated", "Page map updated.");
    } catch (err) {
      logger.warn({ err, projectId }, "Page map extraction failed (non-fatal)");
    }

    await emitEvent(taskId, "completed", "Task completed.");

    // Drain next queued task in the same batch (if any)
    void drainNextBatchTask(taskId).catch((err) =>
      logger.warn({ err, taskId }, "Failed to drain next batch task"),
    );

    // --- Deduct credits after a successful AI build/refine ---
    if (project.ownerId) {
      void deductCredits(project.ownerId, creditCost, {
        type: kind,
        description: `${kind === "build" ? "Build" : "Refine"} (${agentMode}) — project ${projectId}`,
        projectId,
      }).catch((err) => logger.warn({ err }, "Credit deduction failed (non-fatal)"));
    }

    // Fire-and-forget: escalate any recurring warnings, then write a success knowledge entry
    void maybeEscalateWarnings(projectId, report.warnings ?? []);
    const nativeFeaturesNote =
      report.nativeFeatures && report.nativeFeatures.length > 0
        ? ` Native features used: ${report.nativeFeatures.join(", ")} — these require a real device and cannot be previewed in the web iframe.`
        : "";
    void writeKnowledge({
      title: `${kind === "build" ? "Build" : "Refinement"} completed: "${userPrompt.slice(0, 60)}"`,
      content: `${assistantSummary.slice(0, 400)} — Files created: ${report.filesCreated.length}, changed: ${report.filesChanged.length}, removed: ${report.filesRemoved.length}. Warnings: ${report.warnings?.length ?? 0}.${nativeFeaturesNote}`,
      type: kind,
      category: kind === "build" ? "build" : "refinement",
      severity: (report.warnings?.length ?? 0) > 0 ? "warning" : "info",
      projectId,
      userId: project.ownerId,
      relatedTaskId: taskId,
      relatedVersionId: version?.id,
      tags: [
        ...(report.integrationsNeeded?.map((i) => i.name) ?? []),
        ...(report.nativeFeatures ?? []),
      ],
      diffSummary,
    });

    // Mobile-specific: write Knowledge Vault entries capturing which modules were wired
    if (isMobileProject && report.modulesWired && report.modulesWired.length > 0) {
      const moduleNames = report.modulesWired.map((m) => m.name).join(", ");
      const secretsConsumed = [...new Set(report.modulesWired.flatMap((m) => m.secretsConsumed))];
      void writeKnowledge({
        title: `Mobile modules wired: ${moduleNames.slice(0, 60)}`,
        content: `${kind === "build" ? "Build" : "Refine"} for "${userPrompt.slice(0, 80)}" wired ${report.modulesWired.length} power module(s): ${moduleNames}. Secrets consumed: ${secretsConsumed.length > 0 ? secretsConsumed.join(", ") : "none"}. Warnings: ${report.warnings?.length ?? 0}.`,
        type: kind,
        category: "mobile_module",
        severity: "info",
        projectId,
        userId: project.ownerId,
        relatedTaskId: taskId,
        relatedVersionId: version?.id,
        tags: [...report.modulesWired.map((m) => m.id), "mobile", "expo"],
      });
    }

    // Append a system message so the chat shows the report was produced
    const batchMeta = queueBatchId
      ? { queueBatchId, queueIndex: queueIndex ?? null, queueTotalCount: queueTotalCount ?? null }
      : {};
    await db.insert(chatMessagesTable).values({
      projectId,
      role: "system",
      content: assistantSummary,
      agentMode,
      planMode: false,
      plan: { kind: "report", report, ...batchMeta } as unknown as Record<string, unknown>,
    });
    analyticsOutcome = "success";
    void db
      .insert(buildAnalyticsTable)
      .values({
        taskId,
        projectId,
        userId: project.ownerId ?? null,
        model: MODEL_FOR_MODE[agentMode],
        agentMode,
        kind,
        durationMs: Date.now() - jobStartTime,
        correctionPasses: analyticsCorrectionPasses,
        escalated: wasEscalated,
        outcome: analyticsOutcome,
        primaryErrorCategory: analyticsErrorCategory,
      })
      .catch((err) => logger.warn({ err, taskId }, "Failed to record build analytics (non-fatal)"));
  } catch (err) {
    logger.error({ err, taskId, projectId }, "Builder job failed");
    const message = err instanceof Error ? err.message : "Unknown builder error";
    await emitEvent(taskId, "failed", message);

    // Generate specific fix suggestions via AI (parallel with DB writes)
    const [suggestions] = await Promise.all([
      generateFixSuggestions(userPrompt, message),
      db
        .update(agentTasksTable)
        .set({ status: "failed", result: message, completedAt: sql`now()` })
        .where(eq(agentTasksTable.id, taskId)),
      db
        .update(projectsTable)
        .set({ status: "failed", updatedAt: sql`now()` })
        .where(eq(projectsTable.id, projectId)),
    ]);

    // Store fix suggestions on the task record
    await db
      .update(agentTasksTable)
      .set({
        report: {
          userRequest: userPrompt,
          filesCreated: [],
          filesChanged: [],
          filesRemoved: [],
          previewUpdated: false,
          warnings: [],
          suggestions,
          integrationsNeeded: [],
        },
      })
      .where(eq(agentTasksTable.id, taskId));

    // Record build analytics for the failed job (best-effort, non-fatal)
    void db
      .insert(buildAnalyticsTable)
      .values({
        taskId,
        projectId,
        userId: project?.ownerId ?? null,
        model: MODEL_FOR_MODE[agentMode],
        agentMode,
        kind,
        durationMs: Date.now() - jobStartTime,
        correctionPasses: analyticsCorrectionPasses,
        escalated: wasEscalated,
        outcome: "failed",
        primaryErrorCategory: analyticsErrorCategory,
      })
      .catch((analyticsErr) => logger.warn({ analyticsErr, taskId }, "Failed to record failed build analytics"));

    // Auto-write a diagnostic lesson to the Knowledge Vault
    void autoWriteFailureLesson(userPrompt, message, projectId, project.ownerId);

    // Cancel remaining queued tasks in the same batch
    void cancelRemainingBatchTasks(taskId).catch((err) =>
      logger.warn({ err, taskId }, "Failed to cancel remaining batch tasks"),
    );

    // Post a rich error message with suggestions into the chat
    try {
      const errBatchMeta = queueBatchId
        ? { queueBatchId, queueIndex: queueIndex ?? null, queueTotalCount: queueTotalCount ?? null }
        : {};
      await db.insert(chatMessagesTable).values({
        projectId,
        role: "assistant",
        content: `Build failed: ${message}`,
        agentMode,
        planMode: false,
        plan: { kind: "error", message, suggestions, ...errBatchMeta } as unknown as Record<
          string,
          unknown
        >,
      });
    } catch {
      // best-effort
    }
  }
}

export function enqueueJob(input: JobInput): void {
  setImmediate(() => {
    void runJob(input);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EAS Build Job — mobile cloud builds via Expo Application Services
// ─────────────────────────────────────────────────────────────────────────────

export const EAS_BUILD_CREDIT_COST = 5;

export interface EasJobInput {
  deploymentLogId: number;
  projectId: number;
  userId: string;
  platform: EasPlatform;
  accessToken: string;
  appSlug: string;
  appOwner: string;
  /** Extracted from project files — used to log context but not uploaded to EAS */
  appJsonSummary?: string;
}

async function extractAppJsonSummary(projectId: number): Promise<string> {
  try {
    const [row] = await db
      .select({ content: projectFilesTable.content })
      .from(projectFilesTable)
      .where(
        and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, "app.json")),
      )
      .limit(1);
    if (!row) return "(no app.json found in project files)";
    // Truncate to avoid bloating the log
    return row.content.slice(0, 500);
  } catch {
    return "";
  }
}

async function runEasBuildJob(input: EasJobInput): Promise<void> {
  const { deploymentLogId, projectId, userId, platform, accessToken, appSlug, appOwner } = input;
  // eslint-disable-next-line no-useless-assignment
  let easBuildId: string | null = null;

  try {
    logger.info({ projectId, platform, appSlug, appOwner }, "EAS build job starting");

    await db
      .update(deploymentLogsTable)
      .set({ status: "building", note: "EAS build triggered — waiting for result…" })
      .where(eq(deploymentLogsTable.id, deploymentLogId));

    const build = await triggerEasBuild({ accessToken, appSlug, appOwner, platform });
    easBuildId = build.id;

    await db
      .update(deploymentLogsTable)
      .set({
        buildId: easBuildId,
        status: "building",
        note: `EAS build in progress (id: ${easBuildId})`,
      })
      .where(eq(deploymentLogsTable.id, deploymentLogId));

    // Poll for completion (max 15 min, every 15 s)
    const maxPollMs = 15 * 60 * 1000;
    const pollIntervalMs = 15_000;
    const startTime = Date.now();
    let finalBuild = build;

    while (Date.now() - startTime < maxPollMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
      finalBuild = await getEasBuildStatus(accessToken, easBuildId);
      const deployStatus = mapEasStatusToDeploymentStatus(finalBuild.status);
      await db
        .update(deploymentLogsTable)
        .set({ status: deployStatus, note: `EAS status: ${finalBuild.status}` })
        .where(eq(deploymentLogsTable.id, deploymentLogId));
      if (["finished", "errored", "canceled", "timed-out"].includes(finalBuild.status)) break;
    }

    if (finalBuild.status === "finished") {
      const downloadUrl =
        finalBuild.artifacts?.applicationArchiveUrl ?? finalBuild.artifacts?.buildUrl ?? null;

      let testflightUrl: string | null = null;
      let submissionNote = "";
      try {
        await db
          .update(deploymentLogsTable)
          .set({
            status: "submitting",
            note: "Build succeeded — submitting to store…",
            downloadUrl: downloadUrl ?? undefined,
          })
          .where(eq(deploymentLogsTable.id, deploymentLogId));

        await triggerEasSubmit({ accessToken, buildId: easBuildId, platform, appOwner });
        testflightUrl =
          platform === "ios"
            ? "https://appstoreconnect.apple.com/apps"
            : "https://play.google.com/console";
        submissionNote =
          platform === "ios"
            ? "Submitted to TestFlight. Check App Store Connect for processing status."
            : "Uploaded to Google Play Internal Testing track.";
      } catch (submitErr) {
        logger.warn({ submitErr, easBuildId }, "EAS submit failed (build still succeeded)");
        submissionNote = `Build succeeded. Auto-submit failed: ${submitErr instanceof Error ? submitErr.message : "unknown error"}`;
      }

      await db
        .update(deploymentLogsTable)
        .set({
          status: "submitted",
          downloadUrl: downloadUrl ?? undefined,
          testflightUrl: testflightUrl ?? undefined,
          note: submissionNote,
        })
        .where(eq(deploymentLogsTable.id, deploymentLogId));

      void writeKnowledge({
        title: `EAS ${platform} build succeeded`,
        content: `Project ${projectId} EAS ${platform} build (id: ${easBuildId}) completed and submitted. ${submissionNote}`,
        type: "build",
        category: "event",
        severity: "info",
        projectId,
        userId,
      });

      void db
        .insert(chatMessagesTable)
        .values({
          projectId,
          role: "system",
          content: `${platform === "ios" ? "iOS" : "Android"} cloud build succeeded and submitted. ${submissionNote}`,
          agentMode: "eco",
          planMode: false,
          plan: {
            kind: "report",
            report: {
              userRequest: `EAS ${platform} build`,
              filesCreated: [],
              filesChanged: [],
              filesRemoved: [],
              previewUpdated: false,
              warnings: [],
            },
          } as unknown as Record<string, unknown>,
        })
        .catch(() => {
          /* best-effort */
        });
    } else {
      const errorMsg = finalBuild.error?.message ?? `EAS build ${finalBuild.status}`;
      await db
        .update(deploymentLogsTable)
        .set({ status: "failed", note: errorMsg })
        .where(eq(deploymentLogsTable.id, deploymentLogId));

      void writeKnowledge({
        title: `EAS ${platform} build failed`,
        content: `Project ${projectId} EAS ${platform} build (id: ${easBuildId}) failed: ${errorMsg}. Check credentials in project Secrets.`,
        type: "build",
        category: "diagnostic",
        severity: "error",
        projectId,
        userId,
      });

      void db
        .insert(chatMessagesTable)
        .values({
          projectId,
          role: "assistant",
          content: `${platform === "ios" ? "iOS" : "Android"} cloud build failed: ${errorMsg}`,
          agentMode: "eco",
          planMode: false,
          plan: {
            kind: "error",
            message: errorMsg,
            suggestions: [
              "Check your Apple/Google credentials in the project Secrets tab.",
              "Verify your app.json has a valid bundleIdentifier / package name.",
              "Review the EAS dashboard for detailed build logs.",
            ],
          } as unknown as Record<string, unknown>,
        })
        .catch(() => {
          /* best-effort */
        });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown EAS error";
    logger.error({ err, deploymentLogId, platform }, "EAS build job failed");
    await db
      .update(deploymentLogsTable)
      .set({ status: "failed", note: `Build error: ${message}` })
      .where(eq(deploymentLogsTable.id, deploymentLogId));
  }
}

export function enqueueEasJob(input: EasJobInput): void {
  setImmediate(() => {
    void runEasBuildJob(input);
  });
}

export { extractAppJsonSummary };
