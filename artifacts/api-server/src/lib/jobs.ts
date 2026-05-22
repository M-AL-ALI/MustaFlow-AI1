import { eq, sql, and, inArray, desc, or, asc, isNull } from "drizzle-orm";
import {
  db,
  pool,
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
  projectSuggestionsTable,
  checkRunsTable,
  type TaskReport,
  type FileSnapshotEntry,
} from "@workspace/db";
import {
  runBuildPipeline,
  runRefinePipeline,
  runReactViteBuildPipeline,
  runReactViteRefinePipeline,
  runMobileBuildPipeline,
  runMobileRefinePipeline,
  runNextjsBuildPipeline,
  runNextjsRefinePipeline,
  runNodeApiBuildPipeline,
  runNodeApiRefinePipeline,
  runFlaskBuildPipeline,
  runFlaskRefinePipeline,
  runFastapiBuildPipeline,
  runFastapiRefinePipeline,
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
import { runAudit } from "./auditor";
import { runOrchestration } from "./checks/orchestrator";
import { getCheckByName } from "./checks/registry";
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

/**
 * In-memory per-project advisory lock.
 * Prevents concurrent runJob calls for the same project within this Node.js process.
 * The route-level conflict check is the primary guard; this is a safety net.
 */
const activeProjectJobs = new Set<number>();

export type JobKind = "build" | "refine";

export type AgentIdentity = "planning" | "task" | "main";

export interface JobInput {
  taskId: number;
  projectId: number;
  kind: JobKind;
  userPrompt: string;
  agentMode: AgentMode;
  /** Which of the three agents handles this task. Default "main". */
  agentIdentity?: AgentIdentity;
  /** Structured plan from the Planning Agent (injected into build/refine prompt). */
  planContext?: Record<string, unknown> | null;
  conversationHistory?: ConversationTurn[];
  queueBatchId?: string | null;
  queueIndex?: number | null;
  queueTotalCount?: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent routing — deterministic rules (no AI)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine which agent should handle a request based on context signals.
 * Rules (in priority order):
 *   1. planMode = true          → planning
 *   2. background = true        → task  (always staged for batch review)
 *   3. batchQueued = true       → task  (batch tasks go through staging gate)
 *   4. long prompt (>120 chars) → task  (complex change, worth reviewing)
 *   5. projectHasFiles = false  → task  (initial build, always worth reviewing)
 *   6. otherwise                → main  (short fast direct edit)
 */
export function resolveAgentIdentity(
  prompt: string,
  projectHasFiles: boolean,
  isBackground: boolean,
  isBatchQueued: boolean,
  planMode: boolean,
): AgentIdentity {
  if (planMode) return "planning";
  if (isBackground) return "task";
  if (isBatchQueued) return "task";
  if (prompt.length > 120) return "task";
  if (!projectHasFiles) return "task";
  return "main";
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

type PostBuildSuggestion = {
  title: string;
  description: string;
  category: "feature" | "fix" | "improvement" | "idea";
  prompt: string;
};

/**
 * Generate 3-5 contextual AI suggestions after a successful or failed build.
 * Uses gpt-5-mini (free background work — no credit deduction).
 * Persists results to project_suggestions so the frontend can poll for them.
 *
 * Called via setImmediate so it never blocks the visible pipeline completion.
 */
async function generatePostBuildSuggestions(
  projectId: number,
  taskId: number,
  projectName: string,
  projectKind: string,
  projectFormat: string,
  userPrompt: string,
  assistantSummary: string,
  filePaths: string[],
  activeIntegrations: string,
): Promise<void> {
  try {
    const isMobile = ["mobile-ios", "mobile-android", "mobile-cross"].includes(projectKind);
    const platformHint = isMobile
      ? "React Native / Expo mobile app"
      : projectFormat === "react-vite"
        ? "React + Vite web app (TypeScript + Tailwind CSS)"
        : "static web app (HTML/CSS/JS + Tailwind)";

    const systemPrompt = `You are a senior product/engineering advisor reviewing a just-completed AI-generated ${platformHint} build.
Based on the build context, generate 3-5 specific, actionable next-step suggestions the user could build or improve next.
Each suggestion must be concrete and directly relevant to this project — not generic advice.

Categories:
- feature: a new capability or page to add
- fix: a bug, UX issue, or missing piece to address  
- improvement: make existing functionality better, faster, or more polished
- idea: an experimental or innovative enhancement

OUTPUT STRICT JSON:
{
  "suggestions": [
    { "title": "...", "description": "...", "category": "feature|fix|improvement|idea", "prompt": "..." }
  ]
}

Rules:
- title: 3-6 words max, action-oriented
- description: one sentence (max 15 words) explaining the value
- prompt: exact text to feed the refine pipeline — specific and self-contained (30-80 words)
- Mix categories — don't return all features
- Vary difficulty — include at least one quick win and one more ambitious idea
- If active integrations exist, suggest at least one integration-specific improvement`;

    const userContent = `Project: "${projectName}" (${platformHint})
Last build request: "${userPrompt.slice(0, 200)}"
Build summary: "${assistantSummary.slice(0, 300)}"
Files in project: ${filePaths.slice(0, 20).join(", ")}
${activeIntegrations ? `Active integrations: ${activeIntegrations}` : ""}`;

    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 1200,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { suggestions?: PostBuildSuggestion[] };

    if (!Array.isArray(parsed.suggestions) || parsed.suggestions.length === 0) {
      logger.warn({ taskId, projectId }, "Post-build suggestion generation returned empty array");
      return;
    }

    const validCategories = new Set(["feature", "fix", "improvement", "idea"]);
    const valid = parsed.suggestions
      .filter(
        (s) =>
          typeof s.title === "string" &&
          typeof s.description === "string" &&
          typeof s.category === "string" &&
          typeof s.prompt === "string" &&
          validCategories.has(s.category),
      )
      .slice(0, 5);

    if (valid.length === 0) return;

    await db.insert(projectSuggestionsTable).values(
      valid.map((s) => ({
        projectId,
        taskId,
        title: s.title.slice(0, 120),
        description: s.description.slice(0, 300),
        category: s.category,
        prompt: s.prompt.slice(0, 1000),
        status: "pending" as const,
      })),
    );

    logger.info({ taskId, projectId, count: valid.length }, "Post-build suggestions generated");
  } catch (err) {
    logger.warn({ err, taskId, projectId }, "Post-build suggestion generation failed (non-fatal)");
  }
}

async function drainNextBatchTask(completedTaskId: number): Promise<void> {
  const [completedTask] = await db
    .select()
    .from(agentTasksTable)
    .where(eq(agentTasksTable.id, completedTaskId));
  if (!completedTask?.queueBatchId) return;

  // Staging gate: if any task in this batch is awaiting review, block the queue
  const [batchBlocked] = await db
    .select({ id: agentTasksTable.id })
    .from(agentTasksTable)
    .where(
      and(
        eq(agentTasksTable.queueBatchId, completedTask.queueBatchId),
        eq(agentTasksTable.status, "needs_review"),
      ),
    )
    .limit(1);
  if (batchBlocked) {
    logger.info(
      { completedTaskId, blockedByTaskId: batchBlocked.id, batchId: completedTask.queueBatchId },
      "drainNextBatchTask: blocked — Task Agent awaiting review",
    );
    return;
  }

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

/**
 * After a job completes, drain the next orphaned queued task for the project that has
 * no queueBatchId (i.e. tasks created by the per-project conflict detection in
 * routes/messages.ts and routes/tasks.ts). These never belong to a batch, so
 * drainNextBatchTask won't find them.
 */
async function drainNextProjectTask(projectId: number): Promise<void> {
  // Staging gate: if any task for this project is awaiting review, block the queue
  const [blocked] = await db
    .select({ id: agentTasksTable.id })
    .from(agentTasksTable)
    .where(
      and(eq(agentTasksTable.projectId, projectId), eq(agentTasksTable.status, "needs_review")),
    )
    .limit(1);
  if (blocked) {
    logger.info(
      { projectId, blockedByTaskId: blocked.id },
      "drainNextProjectTask: blocked — Task Agent awaiting review",
    );
    return;
  }

  const [nextTask] = await db
    .select()
    .from(agentTasksTable)
    .where(
      and(
        eq(agentTasksTable.projectId, projectId),
        eq(agentTasksTable.status, "queued"),
        isNull(agentTasksTable.queueBatchId),
      ),
    )
    .orderBy(asc(agentTasksTable.createdAt))
    .limit(1);

  if (!nextTask) return;

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) return;

  const [fileRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(sql`(select 1 from project_files where project_id = ${projectId} limit 1) as f`);
  const hasFiles = (fileRow?.c ?? 0) > 0;

  enqueueJob({
    taskId: nextTask.id,
    projectId,
    kind: hasFiles ? "refine" : "build",
    userPrompt: nextTask.prompt ?? "",
    agentMode: (project.agentMode as AgentMode) ?? "power",
  });
  logger.info({ projectId, nextTaskId: nextTask.id }, "Drained next project-level queued task");
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
  const {
    taskId,
    projectId,
    kind,
    conversationHistory,
    queueBatchId,
    queueIndex,
    queueTotalCount,
  } = input;
  let { userPrompt, agentMode } = input;
  const agentIdentity: AgentIdentity = input.agentIdentity ?? "main";

  const jobStartTime = Date.now();
  let wasEscalated = false;
  let analyticsErrorCategory: string | null = null;
  let analyticsCorrectionPasses = 0;

  // Sanitise prompt before injecting into AI context — strip injection patterns
  const { cleaned: sanitisedPrompt, wasModified: promptWasModified } = sanitisePrompt(userPrompt);
  if (promptWasModified) {
    logger.warn(
      { taskId, projectId },
      "Prompt injection patterns detected and stripped from user prompt",
    );
    userPrompt = sanitisedPrompt;
  }

  // Per-project in-memory lock — fast in-process guard to prevent duplicate enqueue.
  activeProjectJobs.add(projectId);

  // Acquire a Postgres session-level advisory lock keyed by projectId.
  // pg_advisory_lock blocks until the lock is free, serializing same-project jobs
  // across all Node processes / replicas. Released in the finally block.
  const lockClient = await pool.connect();
  let lockAcquired = false;

  try {
    await lockClient.query("SELECT pg_advisory_lock($1::bigint)", [projectId]);
    lockAcquired = true;

    await emitEvent(taskId, "queued", "Task received, starting pipeline…");

    // Atomically transition queued/planning → building/planning.
    // Tasks are created with status "queued" (background) or "planning" (immediate foreground).
    // Using WHERE status IN ('queued','planning') makes the check+update a single round-trip,
    // eliminating the TOCTOU window. If the user dismissed (canceled) the task while we were
    // waiting for the advisory lock, status = 'canceled' so 0 rows are updated → abort cleanly.
    const transitioned = await db
      .update(agentTasksTable)
      .set({ status: kind === "build" ? "building" : "planning", startedAt: sql`now()` })
      .where(
        and(
          eq(agentTasksTable.id, taskId),
          inArray(agentTasksTable.status, ["queued", "planning"]),
        ),
      )
      .returning({ id: agentTasksTable.id });
    if (transitioned.length === 0) {
      logger.info({ taskId, projectId }, "Task was canceled before pipeline started — skipping");
      return;
    }

    // Persist agentIdentity to the task record so queries and the frontend can read it
    if (agentIdentity !== "main") {
      await db.update(agentTasksTable).set({ agentIdentity }).where(eq(agentTasksTable.id, taskId));
    }

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

    const [{ context: knowledgeContext, applied: knowledgeApplied }, conversationSummary] =
      await Promise.all([
        loadKnowledgeContext(projectId, userPrompt),
        (async () => {
          try {
            const [row] = await db
              .select({ content: knowledgeEntriesTable.content })
              .from(knowledgeEntriesTable)
              .where(
                and(
                  eq(knowledgeEntriesTable.projectId, projectId),
                  eq(knowledgeEntriesTable.type, "conversation_summary"),
                ),
              )
              .orderBy(desc(knowledgeEntriesTable.createdAt))
              .limit(1);
            return row?.content ?? undefined;
          } catch {
            return undefined;
          }
        })(),
      ]);

    // Build database context when the project has a provisioned DB
    let databaseContext: string | undefined;
    if (project.dbProvider && project.dbProvider !== "none" && project.dbStatus === "ready") {
      const dbSecretRow = await db
        .select({ name: secretsTable.name })
        .from(secretsTable)
        .where(and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, "DATABASE_URL")))
        .limit(1);
      if (dbSecretRow.length > 0) {
        const providerLabel =
          project.dbProvider === "postgres" ? "PostgreSQL (Neon serverless)" : "SQLite";
        databaseContext = `DATABASE CONTEXT — This project has a provisioned ${providerLabel} database. The DATABASE_URL secret is set and contains the connection string.
When generating or modifying code for this project, you MUST:
1. Use real database queries instead of hardcoded/mock data.
2. Generate a Drizzle ORM schema file at "src/db/schema.ts" (or "drizzle/schema.ts") defining the tables your app needs.
3. Generate a Drizzle config file at "drizzle.config.ts" using process.env.DATABASE_URL as the connection string.
4. Generate migration SQL files in "drizzle/migrations/" for schema changes.
5. For server-side routes (Express/Node), use the pg package (Postgres) or better-sqlite3 (SQLite) connected via process.env.DATABASE_URL.
6. Return real database records from API routes — never placeholder arrays.
7. Add proper error handling for database connection failures.
Stack: Drizzle ORM preferred; raw SQL via parameterized queries is acceptable. Never interpolate user input into SQL. Wrap mutations in transactions where appropriate.`;
      }
    }

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
      // Task Agent: collect files to stage (populated below; not written to project_files)
      let stagingData: Array<{ path: string; content: string; mimeType: string }> = [];
      // Task Agent refine: keep a reference to existing files for building the full merged snapshot
      let existingFilesSnapshot: BuilderFile[] = [];
      let _refineChangedFiles: BuilderFile[] = [];
      let _refineRemovedPaths: string[] = [];

      const isMobileProject = ["mobile-ios", "mobile-android", "mobile-cross"].includes(
        project.kind,
      );
      const isReactViteProject = !isMobileProject && project.projectFormat === "react-vite";
      const isNextjsProject = !isMobileProject && project.stack === "nextjs";
      const isNodeApiProject = !isMobileProject && project.stack === "node-api";
      const isPythonFlaskProject = !isMobileProject && project.stack === "python-flask";
      const isPythonFastapiProject = !isMobileProject && project.stack === "python-fastapi";

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
              and(
                eq(agentTasksTable.projectId, projectId),
                eq(agentTasksTable.status, "completed"),
              ),
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
        await emitEvent(
          taskId,
          "narration",
          isMobileProject
            ? "Let me plan the mobile app structure before writing any code."
            : isReactViteProject
              ? "Let me plan the React + Vite project structure before writing any code."
              : isNodeApiProject
                ? "Let me plan the Node.js project structure before writing any code."
                : isPythonFlaskProject || isPythonFastapiProject
                  ? "Let me plan the Python project structure before writing any code."
                  : "Let me plan the app structure before writing any code.",
        );
        await emitEvent(taskId, "planning", "Reading project configuration…");
        await emitEvent(
          taskId,
          "generating_code",
          isMobileProject
            ? "Generating Expo/React Native app with AI…"
            : isReactViteProject
              ? "Generating React + Vite project with AI…"
              : isNodeApiProject
                ? "Generating Node.js / Express project with AI…"
                : isPythonFlaskProject || isPythonFastapiProject
                  ? "Generating Python / Flask project with AI…"
                  : "Generating app blueprint and code with AI…",
        );

        const stackBuildArgs = {
          projectName: project.name,
          projectKind: project.kind,
          userPrompt,
          agentMode,
          conversationHistory,
          knowledgeContext: knowledgeContext || undefined,
          planContext: input.planContext ?? null,
          conversationSummary,
          onEvent: async (type: string, message: string) => emitEvent(taskId, type, message),
        };

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
          : isReactViteProject
            ? await runReactViteBuildPipeline({
                projectName: project.name,
                projectKind: project.kind,
                userPrompt,
                agentMode,
                conversationHistory,
                knowledgeContext: knowledgeContext || undefined,
                databaseContext,
                planContext: input.planContext ?? null,
                conversationSummary,
                onEvent: async (type, message) => emitEvent(taskId, type, message),
              })
            : isNextjsProject
              ? await runNextjsBuildPipeline(stackBuildArgs)
              : isNodeApiProject
                ? await runNodeApiBuildPipeline(stackBuildArgs)
                : isPythonFlaskProject
                  ? await runFlaskBuildPipeline(stackBuildArgs)
                  : isPythonFastapiProject
                    ? await runFastapiBuildPipeline(stackBuildArgs)
                    : await runBuildPipeline({
                        projectName: project.name,
                        projectKind: project.kind,
                        userPrompt,
                        agentMode,
                        conversationHistory,
                        knowledgeContext: knowledgeContext || undefined,
                        databaseContext,
                        planContext: input.planContext ?? null,
                        conversationSummary,
                      });

        analyticsCorrectionPasses = result.correctionPasses;
        analyticsErrorCategory = result.primaryErrorCategory;

        // Auto-escalation: if correction pass failed, retry at next model tier
        const buildEscalationMode = ESCALATION_MAP[agentMode];
        if (result.correctionFailed && buildEscalationMode && !isMobileProject) {
          logger.info(
            { taskId, projectId, from: agentMode, to: buildEscalationMode },
            "Auto-escalating build to higher model tier",
          );
          await emitEvent(
            taskId,
            "generating_code",
            `Validation failed — escalating to ${buildEscalationMode} mode and retrying…`,
          );
          const escalatedStackBuildArgs = {
            projectName: project.name,
            projectKind: project.kind,
            userPrompt,
            agentMode: buildEscalationMode,
            conversationHistory,
            knowledgeContext: knowledgeContext || undefined,
            planContext: input.planContext ?? null,
            conversationSummary,
            onEvent: async (type: string, message: string) => emitEvent(taskId, type, message),
          };
          const escalatedResult = isReactViteProject
            ? await runReactViteBuildPipeline({
                projectName: project.name,
                projectKind: project.kind,
                userPrompt,
                agentMode: buildEscalationMode,
                conversationHistory,
                knowledgeContext: knowledgeContext || undefined,
                databaseContext,
                planContext: input.planContext ?? null,
                conversationSummary,
              })
            : isNextjsProject
              ? await runNextjsBuildPipeline(escalatedStackBuildArgs)
              : isNodeApiProject
                ? await runNodeApiBuildPipeline(escalatedStackBuildArgs)
                : isPythonFlaskProject
                  ? await runFlaskBuildPipeline(escalatedStackBuildArgs)
                  : isPythonFastapiProject
                    ? await runFastapiBuildPipeline(escalatedStackBuildArgs)
                    : await runBuildPipeline({
                        projectName: project.name,
                        projectKind: project.kind,
                        userPrompt,
                        agentMode: buildEscalationMode,
                        conversationHistory,
                        knowledgeContext: knowledgeContext || undefined,
                        databaseContext,
                        planContext: input.planContext ?? null,
                        conversationSummary,
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
          logger.warn(
            { taskId, projectId, secretFindings },
            "Secrets detected and redacted in generated build files",
          );
          result.report.warnings = [
            ...(result.report.warnings ?? []),
            ...secretFindings.map(
              (f) => `Secrets Scan: ${f.category} detected in ${f.file} and redacted before saving`,
            ),
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

        await emitEvent(
          taskId,
          "narration",
          `${agentIdentity === "task" ? "Staging" : "Writing"} ${result.files.length} file${result.files.length !== 1 ? "s" : ""} ${agentIdentity === "task" ? "to staging for review" : "to the project now"}.`,
        );
        await emitEvent(
          taskId,
          "editing_files",
          agentIdentity === "task"
            ? "Staging generated files for review…"
            : "Writing generated files…",
        );
        for (const f of result.files) {
          await emitEvent(
            taskId,
            "editing_files",
            `${agentIdentity === "task" ? "Staging" : "Writing"} ${f.path}`,
            f.path,
          );
        }
        if (agentIdentity === "task") {
          stagingData = result.files.map((f) => ({
            path: f.path,
            content: f.content,
            mimeType: f.mimeType,
          }));
        } else {
          await writeFiles(projectId, result.files, true);
        }
        diffSummary = computeBuildDiff(result.files);

        report = result.report;
        assistantSummary = result.assistantSummary;
        nextVersionLabel = isMobileProject
          ? "Initial mobile build"
          : isReactViteProject
            ? "Initial React + Vite build"
            : isNextjsProject
              ? "Initial Next.js build"
              : isNodeApiProject
                ? "Initial Node.js API build"
                : isPythonFlaskProject
                  ? "Initial Flask build"
                  : isPythonFastapiProject
                    ? "Initial FastAPI build"
                    : "Initial build";
        filesToSmellScan = result.files;
      } else {
        await emitEvent(
          taskId,
          "narration",
          "Let me read the current project files before making any changes.",
        );
        await emitEvent(taskId, "reading_files", "Reading current project files…");
        const existingFiles = await loadFiles(projectId);
        if (agentIdentity === "task") existingFilesSnapshot = existingFiles;
        await emitEvent(
          taskId,
          "reading_files",
          `Loaded ${existingFiles.length} existing file(s).`,
        );

        // Load unchanged-files hint from the last completed task for this project.
        // These paths were declared untouched by the model in the prior refine turn and are
        // passed to makeCompactManifest so they get a path-only stub instead of a full content
        // block, reducing the token count of the file manifest sent to the model.
        let unchangedFilesHint: string[] = [];
        try {
          const [lastTask] = await db
            .select({ report: agentTasksTable.report })
            .from(agentTasksTable)
            .where(
              and(
                eq(agentTasksTable.projectId, projectId),
                eq(agentTasksTable.status, "completed"),
              ),
            )
            .orderBy(desc(agentTasksTable.completedAt))
            .limit(1);
          unchangedFilesHint = lastTask?.report?.filesUnchanged ?? [];
        } catch (err) {
          logger.warn({ err, taskId }, "Failed to load prior unchangedFiles hint (non-fatal)");
        }

        if (unchangedFilesHint.length > 0) {
          logger.info(
            { taskId, projectId, count: unchangedFilesHint.length },
            "Applying unchangedFiles hint to file manifest — skipping full content for these paths",
          );
        }

        await emitEvent(
          taskId,
          "narration",
          isMobileProject
            ? "Applying your changes to the Expo project now."
            : isReactViteProject
              ? "Applying your changes to the React + Vite project now."
              : isNodeApiProject
                ? "Applying your changes to the Node.js project now."
                : isPythonFlaskProject || isPythonFastapiProject
                  ? "Applying your changes to the Python project now."
                  : "Applying your requested changes to the codebase now.",
        );
        await emitEvent(
          taskId,
          "generating_code",
          isMobileProject
            ? "Applying change to Expo project with AI…"
            : isReactViteProject
              ? "Applying change to React + Vite project with AI…"
              : isNodeApiProject
                ? "Applying change to Node.js project with AI…"
                : isPythonFlaskProject || isPythonFastapiProject
                  ? "Applying change to Python project with AI…"
                  : "Applying change request with AI…",
        );

        const stackRefineArgs = {
          projectName: project.name,
          projectKind: project.kind,
          userPrompt,
          agentMode,
          existingFiles,
          conversationHistory,
          knowledgeContext: knowledgeContext || undefined,
          unchangedFilesHint: unchangedFilesHint.length > 0 ? unchangedFilesHint : undefined,
          planContext: input.planContext ?? null,
          conversationSummary,
          onEvent: async (type: string, message: string) => emitEvent(taskId, type, message),
        };

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
          : isReactViteProject
            ? await runReactViteRefinePipeline({
                projectName: project.name,
                projectKind: project.kind,
                userPrompt,
                agentMode,
                existingFiles,
                conversationHistory,
                knowledgeContext: knowledgeContext || undefined,
                databaseContext,
                unchangedFilesHint: unchangedFilesHint.length > 0 ? unchangedFilesHint : undefined,
                planContext: input.planContext ?? null,
                conversationSummary,
                onEvent: async (type, message) => emitEvent(taskId, type, message),
              })
            : isNextjsProject
              ? await runNextjsRefinePipeline(stackRefineArgs)
              : isNodeApiProject
                ? await runNodeApiRefinePipeline(stackRefineArgs)
                : isPythonFlaskProject
                  ? await runFlaskRefinePipeline(stackRefineArgs)
                  : isPythonFastapiProject
                    ? await runFastapiRefinePipeline(stackRefineArgs)
                    : await runRefinePipeline({
                        projectName: project.name,
                        projectKind: project.kind,
                        userPrompt,
                        agentMode,
                        existingFiles,
                        conversationHistory,
                        knowledgeContext: knowledgeContext || undefined,
                        databaseContext,
                        unchangedFilesHint:
                          unchangedFilesHint.length > 0 ? unchangedFilesHint : undefined,
                        planContext: input.planContext ?? null,
                        conversationSummary,
                      });

        analyticsCorrectionPasses = refineResult.correctionPasses;
        analyticsErrorCategory = refineResult.primaryErrorCategory;

        // Auto-escalation: if correction pass failed, retry at next model tier
        const refineEscalationMode = ESCALATION_MAP[agentMode];
        if (refineResult.correctionFailed && refineEscalationMode && !isMobileProject) {
          logger.info(
            { taskId, projectId, from: agentMode, to: refineEscalationMode },
            "Auto-escalating refine to higher model tier",
          );
          await emitEvent(
            taskId,
            "generating_code",
            `Validation failed — escalating to ${refineEscalationMode} mode and retrying…`,
          );
          const escalatedStackRefineArgs = {
            projectName: project.name,
            projectKind: project.kind,
            userPrompt,
            agentMode: refineEscalationMode,
            existingFiles,
            conversationHistory,
            knowledgeContext: knowledgeContext || undefined,
            unchangedFilesHint: unchangedFilesHint.length > 0 ? unchangedFilesHint : undefined,
            planContext: input.planContext ?? null,
            conversationSummary,
            onEvent: async (type: string, message: string) => emitEvent(taskId, type, message),
          };
          const escalatedResult = isReactViteProject
            ? await runReactViteRefinePipeline({
                projectName: project.name,
                projectKind: project.kind,
                userPrompt,
                agentMode: refineEscalationMode,
                existingFiles,
                conversationHistory,
                knowledgeContext: knowledgeContext || undefined,
                databaseContext,
                unchangedFilesHint: unchangedFilesHint.length > 0 ? unchangedFilesHint : undefined,
                planContext: input.planContext ?? null,
                conversationSummary,
              })
            : isNextjsProject
              ? await runNextjsRefinePipeline(escalatedStackRefineArgs)
              : isNodeApiProject
                ? await runNodeApiRefinePipeline(escalatedStackRefineArgs)
                : isPythonFlaskProject
                  ? await runFlaskRefinePipeline(escalatedStackRefineArgs)
                  : isPythonFastapiProject
                    ? await runFastapiRefinePipeline(escalatedStackRefineArgs)
                    : await runRefinePipeline({
                        projectName: project.name,
                        projectKind: project.kind,
                        userPrompt,
                        agentMode: refineEscalationMode,
                        existingFiles,
                        conversationHistory,
                        knowledgeContext: knowledgeContext || undefined,
                        databaseContext,
                        unchangedFilesHint:
                          unchangedFilesHint.length > 0 ? unchangedFilesHint : undefined,
                        planContext: input.planContext ?? null,
                        conversationSummary,
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
        const { files: sanitisedChangedFiles, findings: refineSecretFindings } = scanForSecrets(
          refineResult.changedFiles,
        );
        if (refineSecretFindings.length > 0) {
          logger.warn(
            { taskId, projectId, refineSecretFindings },
            "Secrets detected and redacted in refined files",
          );
          refineResult.report.warnings = [
            ...(refineResult.report.warnings ?? []),
            ...refineSecretFindings.map(
              (f) => `Secrets Scan: ${f.category} detected in ${f.file} and redacted before saving`,
            ),
          ];
        }
        refineResult = { ...refineResult, changedFiles: sanitisedChangedFiles };

        // Cross-file consistency check on the merged project file set
        const mergedFilesForConsistency = [...existingFiles];
        for (const cf of refineResult.changedFiles) {
          const idx = mergedFilesForConsistency.findIndex((f) => f.path === cf.path);
          if (idx >= 0) mergedFilesForConsistency[idx] = cf;
          else mergedFilesForConsistency.push(cf);
        }
        const refineConsistencyWarnings = validateCrossFileConsistency(mergedFilesForConsistency);
        if (refineConsistencyWarnings.length > 0) {
          refineResult.report.warnings = [
            ...(refineResult.report.warnings ?? []),
            ...refineConsistencyWarnings,
          ];
        }

        const result = refineResult;

        const changedCount = result.changedFiles.length + result.removedPaths.length;
        await emitEvent(
          taskId,
          "narration",
          changedCount === 0
            ? "No files needed changing — your app is already up to date."
            : `Writing ${changedCount} updated file${changedCount !== 1 ? "s" : ""} to the project.`,
        );
        await emitEvent(
          taskId,
          "editing_files",
          `AI returned ${result.changedFiles.length} changed file(s).`,
        );

        if (result.changedFiles.length > 0) {
          for (const f of result.changedFiles) {
            await emitEvent(
              taskId,
              "editing_files",
              agentIdentity === "task" ? `Staging ${f.path}` : `Updating ${f.path}`,
              f.path,
            );
          }
          if (agentIdentity !== "task") {
            await writeFiles(projectId, result.changedFiles, false);
          }
        }
        if (result.removedPaths.length > 0) {
          for (const p of result.removedPaths) {
            await emitEvent(taskId, "editing_files", `Removing ${p}`, p);
          }
          if (agentIdentity !== "task") {
            await deleteFiles(projectId, result.removedPaths);
          }
        }
        if (agentIdentity === "task") {
          // Build the full merged file set so the staging snapshot is self-contained
          _refineChangedFiles = result.changedFiles;
          _refineRemovedPaths = result.removedPaths;
          const merged = [...existingFilesSnapshot];
          for (const cf of result.changedFiles) {
            const idx = merged.findIndex((f) => f.path === cf.path);
            if (idx >= 0) merged[idx] = cf;
            else merged.push(cf);
          }
          stagingData = merged
            .filter((f) => !result.removedPaths.includes(f.path))
            .map((f) => ({ path: f.path, content: f.content, mimeType: f.mimeType }));
        }
        diffSummary = computeRefineDiff(existingFiles, result.changedFiles, result.removedPaths);

        report = result.report;

        // Surface unchanged-files count in the task report so the report card can display it.
        // Also persists the list for the next refine turn's manifest pruning hint.
        if (result.unchangedFiles.length > 0) {
          report.filesUnchanged = result.unchangedFiles;
          logger.info(
            { taskId, projectId, count: result.unchangedFiles.length },
            "Refine: skipped writeFiles for unchanged paths (already correct in DB)",
          );
        }

        assistantSummary = result.assistantSummary;
        nextVersionLabel = userPrompt.slice(0, 40) || "Refinement";
        filesToSmellScan = result.changedFiles;
      }

      // Attach knowledge lessons that influenced this build
      if (knowledgeApplied.length > 0) {
        report.knowledgeApplied = knowledgeApplied;
      }

      // ── Task Agent staging gate ────────────────────────────────────────────
      // If this job runs as the Task Agent, write files to stagingSnapshot
      // instead of committing directly to project_files.
      // Post-build hooks (version save, knowledge vault, audit) fire at apply time.
      if (agentIdentity === "task") {
        await db
          .update(agentTasksTable)
          .set({
            status: "needs_review",
            result: assistantSummary,
            report,
            stagingSnapshot: stagingData,
            completedAt: sql`now()`,
          })
          .where(eq(agentTasksTable.id, taskId));

        await emitEvent(
          taskId,
          "completed",
          `Task Agent: ${stagingData.length} file(s) staged for review — apply or discard.`,
        );

        // Post a chat system message so the user sees the review card
        const batchMetaStaging = queueBatchId
          ? {
              queueBatchId,
              queueIndex: queueIndex ?? null,
              queueTotalCount: queueTotalCount ?? null,
            }
          : {};
        await db.insert(chatMessagesTable).values({
          projectId,
          role: "system",
          content: assistantSummary,
          agentMode,
          planMode: false,
          plan: {
            kind: "report",
            report,
            taskId,
            agentIdentity: "task",
            needsReview: true,
            ...batchMetaStaging,
          } as unknown as Record<string, unknown>,
        });

        void writeKnowledge({
          title: `Task Agent staged: "${userPrompt.slice(0, 60)}"`,
          content: `Task Agent completed "${userPrompt.slice(0, 100)}" and staged ${stagingData.length} file(s) for review.`,
          type: kind,
          category: kind === "build" ? "build" : "refinement",
          severity: "info",
          projectId,
          userId: project.ownerId,
          relatedTaskId: taskId,
          tags: ["task-agent", "staged"],
        });

        // Drain batch tasks but keep project queue blocked until apply/discard
        void drainNextBatchTask(taskId).catch((err) =>
          logger.warn({ err, taskId }, "Failed to drain next batch task (task agent staged)"),
        );

        return;
      }
      // ── End Task Agent staging gate ────────────────────────────────────────

      await emitEvent(
        taskId,
        "narration",
        "Saving a rollback checkpoint and refreshing the preview.",
      );
      await emitEvent(taskId, "saving_version", "Saving version rollback point…");
      const snapshot = await snapshotFilesForVersion(projectId);

      // Fetch the most recent plan snapshot to annotate this version
      const planSnapshot = await loadLatestPlanSnapshot(projectId);

      // Build changelog entry: combine action context with diff summary
      const changelogLines: string[] = [];
      changelogLines.push(`**${nextVersionLabel}**`);
      if (kind === "build") {
        changelogLines.push(
          `Initial build — ${(report.filesCreated ?? []).length} file(s) generated.`,
        );
      } else if (diffSummary) {
        if (diffSummary.filesAdded.length > 0)
          changelogLines.push(`Added: ${diffSummary.filesAdded.join(", ")}`);
        if (diffSummary.filesModified.length > 0)
          changelogLines.push(`Modified: ${diffSummary.filesModified.join(", ")}`);
        if (diffSummary.filesRemoved.length > 0)
          changelogLines.push(`Removed: ${diffSummary.filesRemoved.join(", ")}`);
      }
      if (assistantSummary) changelogLines.push(assistantSummary.slice(0, 180));
      const changelogEntry = changelogLines.join("\n");

      const [version] = await db
        .insert(projectVersionsTable)
        .values({
          projectId,
          label: nextVersionLabel,
          note: assistantSummary.slice(0, 200),
          changelogEntry: changelogEntry.slice(0, 500),
          filesSnapshot: snapshot,
          planSnapshot: planSnapshot ?? undefined,
        })
        .returning();
      report.versionId = version?.id ?? null;

      await emitEvent(taskId, "updating_preview", "Refreshing preview…");

      // ── Synchronous Drizzle migration (before task completion) ─────────────
      // Gate: only trigger when THIS build's written files include Drizzle
      // schema/migration files.  filesToSmellScan = result.files (build) or
      // changedFiles (refine) — so we only migrate on builds that actually touch
      // the database schema, not on every refine of an unrelated file.
      {
        const drizzleFilesInBuild = filesToSmellScan.filter(
          (f) =>
            f.path.startsWith("drizzle/") ||
            f.path === "drizzle.config.ts" ||
            f.path === "drizzle.config.js" ||
            f.path === "drizzle.config.mjs" ||
            f.path === "drizzle.config.cjs",
        );

        if (drizzleFilesInBuild.length > 0) {
          const [containerRow] = await db
            .select({
              containerId: projectsTable.containerId,
              containerStatus: projectsTable.containerStatus,
            })
            .from(projectsTable)
            .where(eq(projectsTable.id, projectId));

          if (!containerRow?.containerId) {
            // No container provisioned — surface as a prominent report warning so
            // users know their schema changes won't take effect until a container
            // is started and migrations are run.
            const noContainerWarn =
              "Drizzle schema files were generated but no container is running. Start a container from the Terminal tab to apply database migrations.";
            logger.warn({ projectId, taskId }, noContainerWarn);
            report.warnings = [...(report.warnings ?? []), noContainerWarn];
          } else {
            const activeContainerId = containerRow.containerId;
            const { syncFilesToContainer, execInContainer, startContainer, getContainerStatus } =
              await import("./container");

            // Wake the container if it is not already running.
            if (containerRow.containerStatus !== "running") {
              await emitEvent(taskId, "narration", "Waking container for database migrations…");
              await startContainer(activeContainerId, projectId);
              // Poll up to 30 s for the container to reach "running".
              const wakeDeadline = Date.now() + 30_000;
              while (Date.now() < wakeDeadline) {
                const liveStatus = await getContainerStatus(activeContainerId);
                if (liveStatus === "running") break;
                await new Promise<void>((r) => setTimeout(r, 2000));
              }
            }

            // Fetch all current project files so the container has the full picture.
            const allCurrentFiles = await db
              .select({ path: projectFilesTable.path, content: projectFilesTable.content })
              .from(projectFilesTable)
              .where(eq(projectFilesTable.projectId, projectId));

            // Sync files first so the container sees the latest schema.
            await emitEvent(taskId, "narration", "Syncing files to container for migration…");
            await syncFilesToContainer(activeContainerId, projectId, allCurrentFiles);

            // npm install so drizzle-kit is available.
            const hasPackageJson = allCurrentFiles.some((f) => f.path === "package.json");
            if (hasPackageJson) {
              await emitEvent(taskId, "narration", "Running npm install before migration…");
              await execInContainer(
                activeContainerId,
                ["npm", "install", "--prefer-offline", "--no-audit"],
                projectId,
              );
            }

            // Choose the migration command: prefer an explicit db:push npm script,
            // otherwise fall back to npx drizzle-kit migrate.
            let migrationCmd: string[];
            try {
              const pkgFile = allCurrentFiles.find((f) => f.path === "package.json");
              const pkgJson = pkgFile
                ? (JSON.parse(pkgFile.content) as { scripts?: Record<string, string> })
                : null;
              migrationCmd =
                pkgJson?.scripts?.["db:push"] != null
                  ? ["npm", "run", "db:push"]
                  : ["npx", "drizzle-kit", "migrate"];
            } catch {
              migrationCmd = ["npx", "drizzle-kit", "migrate"];
            }

            await emitEvent(
              taskId,
              "narration",
              `Running database migrations: ${migrationCmd.join(" ")}…`,
            );

            const migrationResult = await execInContainer(
              activeContainerId,
              migrationCmd,
              projectId,
            );

            if (!migrationResult.ok) {
              const errorMsg = `Database migration failed: ${migrationResult.output.slice(0, 400)}`;
              logger.warn(
                { projectId, taskId, output: migrationResult.output },
                "Drizzle migration failed — marking task as failed",
              );
              await emitEvent(taskId, "failed", errorMsg);
              await db
                .update(agentTasksTable)
                .set({
                  status: "failed",
                  result: errorMsg,
                  report: {
                    ...report,
                    warnings: [...(report.warnings ?? []), errorMsg],
                  },
                  completedAt: sql`now()`,
                })
                .where(eq(agentTasksTable.id, taskId));
              return;
            }

            await emitEvent(taskId, "narration", "Database migrations completed successfully.");
            logger.info({ projectId, taskId }, "Drizzle migration completed");
          }
        }
      }
      // ── End synchronous Drizzle migration ─────────────────────────────────

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

      // Fire-and-forget orchestrated checks — secret-leak, code-quality, SAST,
      // accessibility, SEO, performance, CDN security. The AI selects which checks
      // to run based on what changed. Always-on checks (secret-leak, code-quality)
      // always run. Results are persisted to check_runs and merged into the task report.
      // An AuditReport is also derived for backward-compat with the existing Quality tab.
      if (version && filesToSmellScan.length > 0) {
        const versionIdForChecks = version.id;
        const taskIdForChecks = taskId;
        const diffForOrchestrator: {
          filesAdded: string[];
          filesModified: string[];
          filesRemoved: string[];
        } = {
          filesAdded: diffSummary?.filesAdded ?? [],
          filesModified: diffSummary?.filesModified ?? [],
          filesRemoved: diffSummary?.filesRemoved ?? [],
        };
        const summaryForOrchestrator = assistantSummary;
        const kindForOrchestrator = project.kind;

        setImmediate(() => {
          void (async () => {
            try {
              const allProjectFiles = await db
                .select()
                .from(projectFilesTable)
                .where(eq(projectFilesTable.projectId, projectId));
              const checkFiles = allProjectFiles.map((f) => ({
                path: f.path,
                content: f.content,
                mimeType: f.mimeType,
              }));
              const filesToCheck = checkFiles.length > 0 ? checkFiles : filesToSmellScan;

              const { runs, checkSummary } = await runOrchestration(
                filesToCheck,
                diffForOrchestrator,
                summaryForOrchestrator,
                kindForOrchestrator,
              );

              // Persist to check_runs table
              if (runs.length > 0) {
                await db.insert(checkRunsTable).values(
                  runs.map((r) => ({
                    projectId,
                    taskId: taskIdForChecks,
                    checkName: r.checkName,
                    status: r.status,
                    findings: r.findings,
                    aiReason: r.aiReason,
                  })),
                );
              }

              // Summary stats for the task report
              const checkRunsSummary = {
                passed: runs.filter((r) => r.status === "pass").length,
                warnings: runs.filter((r) => r.status === "warning").length,
                failed: runs.filter((r) => r.status === "fail").length,
                skipped: runs.filter((r) => r.status === "skipped").length,
                failedChecks: runs.filter((r) => r.status === "fail").map((r) => r.checkName),
                warnChecks: runs.filter((r) => r.status === "warning").map((r) => r.checkName),
              };

              // Build backward-compat AuditReport from check results
              const AUDIT_CHECK_MAP: Record<
                string,
                "accessibility" | "seo" | "performance" | "security"
              > = {
                accessibility: "accessibility",
                seo: "seo",
                performance: "performance",
                "cdn-security": "security",
              };
              const auditFindings: Array<{
                category: "accessibility" | "seo" | "performance" | "security";
                severity: "error" | "warning" | "info";
                file: string;
                message: string;
                suggestion: string;
              }> = [];
              for (const run of runs) {
                const category = AUDIT_CHECK_MAP[run.checkName];
                if (!category) continue;
                for (const f of run.findings) {
                  auditFindings.push({
                    category,
                    severity: f.severity,
                    file: f.file,
                    message: f.message,
                    suggestion: f.detail ?? f.message,
                  });
                }
              }

              const auditCategories = ["accessibility", "seo", "performance", "security"] as const;
              const CHECKS_PER_CATEGORY = 6;
              const auditScores = auditCategories.map((cat) => {
                const catFindings = auditFindings.filter((f) => f.category === cat);
                const failures = catFindings.filter((f) => f.severity === "error").length;
                const warnings = catFindings.filter((f) => f.severity === "warning").length;
                const penalty = failures * 2 + warnings;
                const pass = Math.max(0, CHECKS_PER_CATEGORY - Math.ceil(catFindings.length));
                const score = Math.max(0, Math.round(100 - (penalty / CHECKS_PER_CATEGORY) * 100));
                const LABELS = {
                  accessibility: "Accessibility",
                  seo: "SEO",
                  performance: "Performance",
                  security: "Security",
                };
                return { category: cat, label: LABELS[cat], pass, warnings, failures, score };
              });

              const htmlFileCount = filesToCheck.filter(
                (f) => f.mimeType === "text/html" || f.path.endsWith(".html"),
              ).length;

              const auditReport = {
                findings: auditFindings,
                scores: auditScores,
                auditedAt: new Date().toISOString(),
                fileCount: htmlFileCount,
              };

              // Persist AuditReport on the version row (backward compat with GET /api/projects/:id/audit)
              await db
                .update(projectVersionsTable)
                .set({ auditReport })
                .where(eq(projectVersionsTable.id, versionIdForChecks));

              // Read latest task report from DB before merging (avoids clobbering concurrent code-smell scan)
              const [latestTask] = await db
                .select({ report: agentTasksTable.report })
                .from(agentTasksTable)
                .where(eq(agentTasksTable.id, taskIdForChecks))
                .limit(1);
              const latestReport = (latestTask?.report ?? report) as TaskReport;
              const updatedReport: TaskReport = {
                ...latestReport,
                auditReport,
                checkSummary,
                checkRunsSummary,
              };
              await db
                .update(agentTasksTable)
                .set({ report: updatedReport })
                .where(eq(agentTasksTable.id, taskIdForChecks));

              logger.info(
                { projectId, taskId: taskIdForChecks, checkCount: runs.length, checkSummary },
                "Orchestrated checks complete",
              );

              // ── Auto-fix on check failure ─────────────────────────────────
              // When project.autoFixOnCheckFailure is enabled and one or more
              // checks failed, automatically enqueue a single background refine
              // task that addresses each failed check.
              // Guard: skip if the triggering task is itself an auto-fix (title
              // starts with "Auto-fix:") to prevent cascading loops.
              const isAutoFixTask = (input.userPrompt ?? "").startsWith("Auto-fix:");
              if (
                project.autoFixOnCheckFailure &&
                checkRunsSummary.failed > 0 &&
                !isAutoFixTask
              ) {
                try {
                  const failedRuns = runs.filter((r) => r.status === "fail");
                  const fixParts: string[] = [];
                  for (const run of failedRuns) {
                    const checkDef = getCheckByName(run.checkName);
                    if (checkDef?.fixPrompt) {
                      fixParts.push(checkDef.fixPrompt);
                    }
                  }
                  if (fixParts.length > 0) {
                    const checkNames = failedRuns.map((r) => r.checkName).join(", ");
                    const autoFixPrompt = fixParts.join(" Additionally, ");
                    const autoFixTitle = `Auto-fix: ${checkNames}`;

                    const autoFixResult = await pool.query<{ id: number }>(
                      `INSERT INTO agent_tasks (project_id, title, kind, status, prompt)
                       VALUES ($1, $2, 'background', 'queued', $3)
                       ON CONFLICT (project_id, title)
                       WHERE kind = 'background' AND status IN ('queued', 'building', 'planning')
                       DO NOTHING
                       RETURNING id`,
                      [projectId, autoFixTitle, autoFixPrompt],
                    );

                    if (autoFixResult.rows.length === 0) {
                      logger.info(
                        { projectId, taskId: taskIdForChecks },
                        "Auto-fix on check failure already queued — skipping duplicate enqueue",
                      );
                    } else {
                      const followUpTask = autoFixResult.rows[0];
                      if (followUpTask) {
                        await db.insert(chatMessagesTable).values([
                          {
                            projectId,
                            role: "user",
                            content: autoFixPrompt,
                            agentMode,
                            planMode: false,
                          },
                          {
                            projectId,
                            role: "assistant",
                            content: `${failedRuns.length} check${failedRuns.length !== 1 ? "s" : ""} failed (${checkNames}). Auto-fix is enabled — I've queued a targeted fix (Task #${followUpTask.id}) that will run in the background and post a report here when complete.`,
                            agentMode,
                            planMode: false,
                            plan: {
                              kind: "task-queued",
                              taskId: followUpTask.id,
                            } as unknown as Record<string, unknown>,
                          },
                        ]);
                        enqueueJob({
                          taskId: followUpTask.id,
                          projectId,
                          kind: "refine",
                          userPrompt: autoFixPrompt,
                          agentMode,
                        });
                        logger.info(
                          {
                            projectId,
                            taskId: taskIdForChecks,
                            followUpTaskId: followUpTask.id,
                            checkNames,
                          },
                          "Auto-fix on check failure enqueued",
                        );
                      }
                    }
                  }
                } catch (autoFixErr) {
                  logger.warn(
                    { err: autoFixErr, projectId, taskId: taskIdForChecks },
                    "Auto-fix on check failure enqueue failed (non-fatal)",
                  );
                }
              }
              // ── End auto-fix on check failure ─────────────────────────────
            } catch (err) {
              logger.warn(
                { err, projectId, versionId: versionIdForChecks },
                "Orchestrated checks failed (non-fatal)",
              );
            }
          })();
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

      // Sync files to live container and run npm install (best-effort, non-fatal).
      // Only runs when a container is active for this project.
      setImmediate(() => {
        void (async () => {
          try {
            const [containerRow] = await db
              .select({
                containerId: projectsTable.containerId,
                containerStatus: projectsTable.containerStatus,
              })
              .from(projectsTable)
              .where(eq(projectsTable.id, projectId));

            if (!containerRow?.containerId || containerRow.containerStatus !== "running") return;

            const { containerId } = containerRow;

            // Import dynamically to keep this module tree-shakeable.
            const { syncFilesToContainer, execInContainer } = await import("./container");

            const allFiles = await db
              .select({ path: projectFilesTable.path, content: projectFilesTable.content })
              .from(projectFilesTable)
              .where(eq(projectFilesTable.projectId, projectId));

            await emitEvent(taskId, "narration", "Syncing files to container…");
            await syncFilesToContainer(containerId, projectId, allFiles);

            // Run npm install if a package.json was written
            const hasPackageJson = allFiles.some((f) => f.path === "package.json");
            if (hasPackageJson) {
              await emitEvent(taskId, "narration", "Running npm install in container…");
              const installResult = await execInContainer(
                containerId,
                ["npm", "install", "--prefer-offline", "--no-audit"],
                projectId,
              );
              if (!installResult.ok) {
                logger.warn({ projectId, taskId }, "npm install in container exited non-zero");
              }
            }

            await emitEvent(taskId, "narration", "Container ready.");
          } catch (err) {
            logger.warn({ err, projectId, taskId }, "Container sync/install failed (non-fatal)");
          }
        })();
      });

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

      // Drain batch tasks, then any orphaned project-level queued tasks
      void drainNextBatchTask(taskId).catch((err) =>
        logger.warn({ err, taskId }, "Failed to drain next batch task"),
      );
      void drainNextProjectTask(projectId).catch((err) =>
        logger.warn({ err, projectId }, "Failed to drain next project task"),
      );

      // Generate post-build suggestions in the background (non-blocking)
      setImmediate(() => {
        void generatePostBuildSuggestions(
          projectId,
          taskId,
          project.name,
          project.kind,
          project.projectFormat ?? "static-html",
          userPrompt,
          assistantSummary,
          snapshot.map((f) => f.path),
          knowledgeContext,
        ).catch((err) => logger.warn({ err, taskId }, "Background suggestion generation failed"));
      });

      // Run AI-generated browser tests in the background (non-blocking, non-fatal)
      // Only runs for web (non-mobile) projects that produce HTML output
      if (!isMobileProject) {
        setImmediate(() => {
          void runAppTestingJob(projectId, taskId, project.name ?? project.kind).catch((err) =>
            logger.warn({ err, taskId }, "Background app-testing job failed"),
          );
        });
      }

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

      // If Moment.js was detected in this build, write a Knowledge Vault lesson so future
      // builds actively avoid it and use Luxon or date-fns instead.
      const hasMomentNotice = (report.securityNotices ?? []).some((n) =>
        n.packageName.toLowerCase().includes("moment"),
      );
      if (hasMomentNotice) {
        void writeKnowledge({
          title: "Avoid Moment.js — use Luxon or date-fns instead",
          content:
            "Moment.js is End of Life and will not receive security fixes. For all date formatting and manipulation in generated apps, use native JavaScript (Intl.DateTimeFormat, Date methods) where possible. When a CDN library is needed, prefer Luxon (https://cdn.jsdelivr.net/npm/luxon@3/build/global/luxon.min.js) or date-fns (https://cdn.jsdelivr.net/npm/date-fns@3/cdn.min.js). Never load moment from any CDN.",
          type: kind,
          category: "lesson",
          severity: "warning",
          projectId,
          userId: project.ownerId,
          relatedTaskId: taskId,
          relatedVersionId: version?.id,
          tags: ["moment", "date", "security", "eol", "luxon", "date-fns"],
          approvedForReuse: true,
        });
        logger.info({ projectId, taskId }, "Moment.js detected — wrote Knowledge Vault lesson");
      }
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
        plan: { kind: "report", report, taskId, ...batchMeta } as unknown as Record<
          string,
          unknown
        >,
      });

      // If Moment.js was detected in an initial build, automatically enqueue a follow-up refine
      // that swaps it for Luxon. Only fires on builds (not on refines) to avoid infinite loops.
      // This runs as a fire-and-forget background job — failures never affect the build result.
      if (kind === "build" && hasMomentNotice) {
        void (async () => {
          try {
            const MOMENT_REPLACE_PROMPT =
              "Replace Moment.js with Luxon — remove the Moment.js CDN script tag and rewrite all moment(...) calls using Luxon's DateTime API.";

            // Idempotency guard backed by a DB-enforced partial unique index:
            //   agent_tasks_active_background_title_idx ON agent_tasks(project_id, title)
            //   WHERE kind = 'background' AND status IN ('queued','building','planning')
            // ON CONFLICT DO NOTHING is race-safe — if two concurrent builds both attempt
            // to insert, the second will silently skip rather than creating a duplicate.
            // Once a previous auto-fix resolves (status → done/failed/canceled), the row
            // falls outside the partial index and a new auto-fix can be enqueued.
            const autoFixResult = await pool.query<{ id: number }>(
              `INSERT INTO agent_tasks (project_id, title, kind, status, prompt)
               VALUES ($1, $2, 'background', 'queued', $3)
               ON CONFLICT (project_id, title)
               WHERE kind = 'background' AND status IN ('queued', 'building', 'planning')
               DO NOTHING
               RETURNING id`,
              [projectId, "Auto-fix: Replace Moment.js with Luxon", MOMENT_REPLACE_PROMPT],
            );
            if (autoFixResult.rows.length === 0) {
              logger.info(
                { projectId, taskId },
                "Moment.js auto-fix already queued — skipping duplicate enqueue",
              );
              return;
            }
            const followUpTask = autoFixResult.rows[0];
            if (!followUpTask) {
              logger.warn(
                { projectId, taskId },
                "Moment.js auto-fix: failed to insert follow-up task row",
              );
              return;
            }
            await db.insert(chatMessagesTable).values([
              {
                projectId,
                role: "user",
                content: MOMENT_REPLACE_PROMPT,
                agentMode,
                planMode: false,
              },
              {
                projectId,
                role: "assistant",
                content: `Moment.js was detected in this build. I've queued an automatic follow-up to replace it with Luxon (Task #${followUpTask.id}). The refine will run in the background and post a report here when complete.`,
                agentMode,
                planMode: false,
                plan: {
                  kind: "task-queued",
                  taskId: followUpTask.id,
                } as unknown as Record<string, unknown>,
              },
            ]);
            enqueueJob({
              taskId: followUpTask.id,
              projectId,
              kind: "refine",
              userPrompt: MOMENT_REPLACE_PROMPT,
              agentMode,
            });
            logger.info(
              { projectId, taskId, followUpTaskId: followUpTask.id },
              "Moment.js auto-fix refine enqueued",
            );
          } catch (err) {
            logger.warn(
              { err, projectId, taskId },
              "Moment.js auto-fix enqueue failed (non-fatal)",
            );
          }
        })();
      }

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
          outcome: "success" as const,
          primaryErrorCategory: analyticsErrorCategory,
        })
        .catch((err) =>
          logger.warn({ err, taskId }, "Failed to record build analytics (non-fatal)"),
        );
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
        .catch((analyticsErr) =>
          logger.warn({ analyticsErr, taskId }, "Failed to record failed build analytics"),
        );

      // Auto-write a diagnostic lesson to the Knowledge Vault
      void autoWriteFailureLesson(userPrompt, message, projectId, project.ownerId);

      // Cancel remaining queued tasks in the same batch
      void cancelRemainingBatchTasks(taskId).catch((err) =>
        logger.warn({ err, taskId }, "Failed to cancel remaining batch tasks"),
      );

      // Generate post-build suggestions even on failure — gives the user recovery ideas
      setImmediate(() => {
        void generatePostBuildSuggestions(
          projectId,
          taskId,
          project.name,
          project.kind,
          project.projectFormat ?? "static-html",
          userPrompt,
          `Build failed: ${message.slice(0, 200)}`,
          [],
          "",
        ).catch((err) => logger.warn({ err, taskId }, "Failure-path suggestion generation failed"));
      });

      // Post a rich error message with suggestions into the chat
      try {
        const errBatchMeta = queueBatchId
          ? {
              queueBatchId,
              queueIndex: queueIndex ?? null,
              queueTotalCount: queueTotalCount ?? null,
            }
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
  } finally {
    // Always release the advisory lock and pool client, and clear the in-memory guard.
    if (lockAcquired) {
      try {
        await lockClient.query("SELECT pg_advisory_unlock($1::bigint)", [projectId]);
      } catch (unlockErr) {
        logger.warn({ unlockErr, projectId }, "Failed to release advisory lock (non-fatal)");
      }
    }
    lockClient.release();
    activeProjectJobs.delete(projectId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Task Agent: Apply & Discard staging snapshots
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a Task Agent staging snapshot to the live project files.
 * Called by POST /projects/:id/tasks/:taskId/apply.
 * Fires all post-build hooks: version save, quality audit, knowledge vault,
 * suggestion generation, credit deduction.
 */
export async function applyTaskAgentStaging(taskId: number, projectId: number): Promise<void> {
  const [task] = await db
    .select()
    .from(agentTasksTable)
    .where(and(eq(agentTasksTable.id, taskId), eq(agentTasksTable.projectId, projectId)))
    .limit(1);
  if (!task) throw new Error("Task not found");
  if (task.status !== "needs_review")
    throw new Error(`Task is in state "${task.status}", not needs_review`);
  if (!task.stagingSnapshot || !Array.isArray(task.stagingSnapshot))
    throw new Error("Task has no staging snapshot to apply");

  const stagingFiles = task.stagingSnapshot as Array<{
    path: string;
    content: string;
    mimeType: string;
  }>;
  const builderFiles: BuilderFile[] = stagingFiles.map((f) => ({
    path: f.path,
    content: f.content,
    mimeType: f.mimeType,
  }));

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) throw new Error("Project not found");

  const report = task.report as TaskReport | null;
  const assistantSummary = task.result ?? `Task #${taskId} applied`;
  const userPrompt = task.prompt ?? "";
  const agentMode = (project.agentMode as AgentMode) ?? "power";

  // Write staging files to project_files (full replace — staging is the intended state)
  await writeFiles(projectId, builderFiles, true);

  // Save version snapshot
  const snapshot = await snapshotFilesForVersion(projectId);
  const planSnapshot = await loadLatestPlanSnapshot(projectId);
  const changelogEntry = `**Task Agent Apply**\n${assistantSummary.slice(0, 180)}`;
  const [version] = await db
    .insert(projectVersionsTable)
    .values({
      projectId,
      label: `Apply Task #${taskId}`,
      note: assistantSummary.slice(0, 200),
      changelogEntry: changelogEntry.slice(0, 500),
      filesSnapshot: snapshot,
      planSnapshot: planSnapshot ?? undefined,
    })
    .returning();

  const finalReport: TaskReport = {
    ...(report ?? {
      userRequest: userPrompt,
      filesCreated: [],
      filesChanged: [],
      filesRemoved: [],
      previewUpdated: true,
      warnings: [],
      integrationsNeeded: [],
    }),
    versionId: version?.id ?? null,
  };

  // Mark task completed + clear staging snapshot
  await db
    .update(agentTasksTable)
    .set({
      status: "completed",
      report: finalReport,
      stagingSnapshot: null,
      completedAt: sql`now()`,
    })
    .where(eq(agentTasksTable.id, taskId));

  // Update project status
  await db
    .update(projectsTable)
    .set({
      status: "testing",
      lastTaskSummary: assistantSummary.slice(0, 140),
      summary: assistantSummary,
      updatedAt: sql`now()`,
    })
    .where(eq(projectsTable.id, projectId));

  // Extract page map
  try {
    await extractPageMap(projectId);
  } catch (err) {
    logger.warn({ err, projectId }, "Page map extraction failed after apply (non-fatal)");
  }

  // Drain queued tasks (the review gate is now open)
  void drainNextProjectTask(projectId).catch((err) =>
    logger.warn({ err, projectId }, "Failed to drain project task after apply"),
  );
  // Also drain the batch queue if this task belonged to a batch
  if (task.queueBatchId) {
    void drainNextBatchTask(taskId).catch((err) =>
      logger.warn({ err, taskId }, "Failed to drain next batch task after apply"),
    );
  }

  // Post-build hooks — quality audit (fire-and-forget)
  if (version) {
    const versionIdForAudit = version.id;
    const taskIdForAudit = taskId;
    setImmediate(() => {
      void (async () => {
        try {
          const auditReport = runAudit(builderFiles);
          await db
            .update(projectVersionsTable)
            .set({ auditReport })
            .where(eq(projectVersionsTable.id, versionIdForAudit));
          const [latestTask] = await db
            .select({ report: agentTasksTable.report })
            .from(agentTasksTable)
            .where(eq(agentTasksTable.id, taskIdForAudit))
            .limit(1);
          const latestReport = latestTask?.report ?? finalReport;
          await db
            .update(agentTasksTable)
            .set({ report: { ...latestReport, auditReport } })
            .where(eq(agentTasksTable.id, taskIdForAudit));
        } catch (err) {
          logger.warn({ err, projectId }, "Quality audit failed after apply (non-fatal)");
        }
      })();
    });
  }

  // Post-build suggestions
  setImmediate(() => {
    void generatePostBuildSuggestions(
      projectId,
      taskId,
      project.name,
      project.kind,
      project.projectFormat ?? "static-html",
      userPrompt,
      assistantSummary,
      snapshot.map((f) => f.path),
      "",
    ).catch((err) => logger.warn({ err, taskId }, "Post-apply suggestion generation failed"));
  });

  // Knowledge vault entry
  void writeKnowledge({
    title: `Task Agent applied: "${userPrompt.slice(0, 60)}"`,
    content: `User approved and applied Task Agent staging for "${userPrompt.slice(0, 100)}". ${stagingFiles.length} file(s) promoted to live.`,
    type: "refine",
    category: "refinement",
    severity: "info",
    projectId,
    userId: project.ownerId,
    relatedTaskId: taskId,
    relatedVersionId: version?.id,
    tags: ["task-agent", "applied"],
  });

  // Credit deduction (post-success, non-fatal)
  if (project.ownerId) {
    const creditCost = CREDIT_COST[agentMode] ?? 1;
    void deductCredits(project.ownerId, creditCost, {
      type: "refine",
      description: `Task Agent apply — Task #${taskId}, project ${projectId}`,
      projectId,
    }).catch((err) => logger.warn({ err }, "Credit deduction failed after apply (non-fatal)"));
  }

  logger.info({ taskId, projectId, fileCount: stagingFiles.length }, "Task Agent staging applied");
}

/**
 * Discard a Task Agent staging snapshot.
 * No project files are changed; the task moves to "discarded" status.
 * Called by POST /projects/:id/tasks/:taskId/discard.
 */
export async function discardTaskAgentStaging(taskId: number, projectId: number): Promise<void> {
  const [task] = await db
    .select({
      status: agentTasksTable.status,
      projectId: agentTasksTable.projectId,
      queueBatchId: agentTasksTable.queueBatchId,
    })
    .from(agentTasksTable)
    .where(and(eq(agentTasksTable.id, taskId), eq(agentTasksTable.projectId, projectId)))
    .limit(1);
  if (!task) throw new Error("Task not found");
  if (task.status !== "needs_review")
    throw new Error(`Task is in state "${task.status}", not needs_review`);

  await db
    .update(agentTasksTable)
    .set({ status: "discarded", stagingSnapshot: null, completedAt: sql`now()` })
    .where(eq(agentTasksTable.id, taskId));

  // Drain the project queue (discard opens the gate too)
  void drainNextProjectTask(projectId).catch((err) =>
    logger.warn({ err, projectId }, "Failed to drain project task after discard"),
  );
  // Also drain the batch queue if this task belonged to a batch
  if (task.queueBatchId) {
    void drainNextBatchTask(taskId).catch((err) =>
      logger.warn({ err, taskId }, "Failed to drain next batch task after discard"),
    );
  }

  void writeKnowledge({
    title: `Task Agent discarded: Task #${taskId}`,
    content: `User discarded Task Agent staging for Task #${taskId}. No files were changed.`,
    type: "refine",
    category: "refinement",
    severity: "info",
    projectId,
    relatedTaskId: taskId,
    tags: ["task-agent", "discarded"],
  });

  logger.info({ taskId, projectId }, "Task Agent staging discarded");
}

// ── Bounded-concurrency background job runner ──────────────────────────────────
// Ensures at most JOB_CONCURRENCY background (non-foreground) AI jobs run at
// once. Jobs submitted beyond the concurrency cap wait in _pendingJobs until
// a slot frees. This provides genuine deferred execution — jobs do not start
// until capacity is available, complementing the HTTP-level queue in
// rateLimit.ts for foreground requests.

const JOB_CONCURRENCY = 3;
let _activeJobs = 0;
const _pendingJobs: Array<JobInput> = [];

function _drainJobs(): void {
  while (_activeJobs < JOB_CONCURRENCY && _pendingJobs.length > 0) {
    const input = _pendingJobs.shift()!;
    _activeJobs++;
    void runJob(input).finally(() => {
      _activeJobs--;
      _drainJobs();
    });
  }
}

export function enqueueJob(input: JobInput): void {
  if (_activeJobs < JOB_CONCURRENCY) {
    _activeJobs++;
    void runJob(input).finally(() => {
      _activeJobs--;
      _drainJobs();
    });
  } else {
    _pendingJobs.push(input);
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// App Testing Job — AI-generated Playwright browser tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate and run AI-driven browser tests for a completed build.
 * Finds index.html from DB, generates test steps via AI, runs them in
 * headless Chromium, and persists results into the task report.
 * Entirely non-fatal — exceptions are caught and logged.
 */
export async function runAppTestingJob(
  projectId: number,
  taskId: number,
  projectDescription: string,
): Promise<void> {
  logger.info({ projectId, taskId }, "App testing job starting");

  // Load index.html from DB
  const [indexFile] = await db
    .select({ content: projectFilesTable.content })
    .from(projectFilesTable)
    .where(
      and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, "index.html")),
    )
    .limit(1);

  if (!indexFile?.content) {
    logger.info(
      { projectId, taskId },
      "No index.html found — skipping browser tests (non-HTML project)",
    );
    return;
  }

  // Generate test plan via AI
  const { runTestGenerationPipeline } = await import("./builder");
  const testPlan = await runTestGenerationPipeline(indexFile.content, projectDescription);

  if (!testPlan) {
    logger.warn({ projectId, taskId }, "Test generation returned null — skipping");
    return;
  }

  logger.info(
    { projectId, taskId, stepCount: testPlan.steps.length },
    "Running Playwright tests",
  );

  // Run tests against the loaded HTML
  const { runTestPlan } = await import("./checks/playwright-runner");
  const testResults = await runTestPlan(indexFile.content, testPlan, { timeoutMs: 5000 });

  const passed = testResults.filter((r) => r.passed).length;
  const failed = testResults.filter((r) => !r.passed).length;

  logger.info({ projectId, taskId, passed, failed }, "Browser tests complete");

  // Persist results into the task report
  const [latestTask] = await db
    .select({ report: agentTasksTable.report })
    .from(agentTasksTable)
    .where(eq(agentTasksTable.id, taskId))
    .limit(1);

  if (!latestTask) return;

  const latestReport = (latestTask.report ?? {}) as import("@workspace/db").TaskReport;
  const updatedReport: import("@workspace/db").TaskReport = {
    ...latestReport,
    testResults,
    testScript: JSON.stringify(testPlan, null, 2),
    testRanAt: new Date().toISOString(),
  };

  await db
    .update(agentTasksTable)
    .set({ report: updatedReport })
    .where(eq(agentTasksTable.id, taskId));

  logger.info({ projectId, taskId, passed, failed }, "Test results saved to task report");
}

export { extractAppJsonSummary };
