import { eq, sql, and, inArray, desc, or } from "drizzle-orm";
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
  type TaskReport,
  type FileSnapshotEntry,
} from "@workspace/db";
import {
  runBuildPipeline,
  runRefinePipeline,
  type BuilderFile,
  type ConversationTurn,
} from "./builder";
import { openai } from "@workspace/integrations-openai-ai-server";
import type { AgentMode } from "./ai";
import { logger } from "./logger";
import { writeKnowledge } from "./knowledge";
import { getOrCreateCredits, deductCredits } from "../routes/credits";

/** Credit cost per AI call, keyed by agentMode. */
const CREDIT_COST: Record<string, number> = {
  lite: 1,
  eco: 2,
  power: 5,
  pro: 10,
};

export type JobKind = "build" | "refine";

export interface JobInput {
  taskId: number;
  projectId: number;
  kind: JobKind;
  userPrompt: string;
  agentMode: AgentMode;
  conversationHistory?: ConversationTurn[];
}

async function emitEvent(
  taskId: number,
  eventType: string,
  message: string,
  filePath?: string,
): Promise<void> {
  try {
    await db.insert(taskEventsTable).values({
      taskId,
      eventType,
      message,
      filePath: filePath ?? null,
    });
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

async function snapshotFilesForVersion(
  projectId: number,
): Promise<FileSnapshotEntry[]> {
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
    await db
      .delete(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId));
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
async function deleteFiles(
  projectId: number,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  await db.delete(projectFilesTable).where(
    and(
      eq(projectFilesTable.projectId, projectId),
      inArray(projectFilesTable.path, paths),
    ),
  );
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
 * then returns the top 15 most relevant (not just the 40 most recent).
 */
async function loadKnowledgeContext(
  projectId: number,
  userPrompt?: string,
): Promise<string> {
  try {
    const entries = await db
      .select()
      .from(knowledgeEntriesTable)
      .where(
        or(
          eq(knowledgeEntriesTable.approvedForReuse, true),
          eq(knowledgeEntriesTable.projectId, projectId),
        ),
      )
      .orderBy(desc(knowledgeEntriesTable.createdAt))
      .limit(80);

    if (entries.length === 0) return "";

    if (userPrompt && userPrompt.length > 0) {
      const promptTokens = tokenise(userPrompt);
      const scored = entries.map((e) => {
        const entryTokens = tokenise(`${e.title} ${e.content} ${e.tags ?? ""}`);
        let overlap = 0;
        for (const t of promptTokens) {
          if (entryTokens.has(t)) overlap++;
        }
        const score = promptTokens.size > 0 ? overlap / promptTokens.size : 0;
        return { entry: e, score };
      });
      scored.sort((a, b) => b.score - a.score);
      const topEntries = scored.slice(0, 15).map((s) => s.entry);
      return topEntries
        .map((e) => `[${e.category}] ${e.title}: ${e.content}`)
        .join("\n");
    }

    // No prompt available — fall back to most recent 15
    return entries
      .slice(0, 15)
      .map((e) => `[${e.category}] ${e.title}: ${e.content}`)
      .join("\n");
  } catch {
    return "";
  }
}

/**
 * Integration catalog: maps known secret key name patterns to precise usage blocks.
 * Injected into the AI prompt when matching secrets are set on the project.
 */
const INTEGRATION_CATALOG: Array<{
  name: string;
  keyPatterns: RegExp[];
  usageBlock: string;
}> = [
  {
    name: "Stripe",
    keyPatterns: [/stripe/i, /STRIPE/],
    usageBlock: `INTEGRATION — Stripe (payment processing):
CDN: <script src="https://js.stripe.com/v3/"></script>
Init: const stripe = Stripe(/* STRIPE_PUBLISHABLE_KEY from project secrets */);
Usage: const elements = stripe.elements(); const card = elements.create('card'); card.mount('#card-element');
Confirm payment: stripe.confirmCardPayment(clientSecret, { payment_method: { card } });
Note: Use publishable key (pk_test_... or pk_live_...) in frontend. Never expose secret key.`,
  },
  {
    name: "Google Maps",
    keyPatterns: [/google.*map/i, /GOOGLE_MAPS/i, /MAPS_API/i],
    usageBlock: `INTEGRATION — Google Maps:
CDN: <script src="https://maps.googleapis.com/maps/api/js?key=/* GOOGLE_MAPS_API_KEY */&callback=initMap" async></script>
Init: function initMap() { const map = new google.maps.Map(document.getElementById('map'), { zoom: 13, center: { lat: 40.7128, lng: -74.006 } }); }
Marker: new google.maps.Marker({ position: { lat, lng }, map, title: 'Label' });
Note: Replace /* GOOGLE_MAPS_API_KEY */ with the variable reference — do not hardcode.`,
  },
  {
    name: "Firebase",
    keyPatterns: [/firebase/i, /FIREBASE/i],
    usageBlock: `INTEGRATION — Firebase:
CDN: <script src="https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js"></script>
     <script src="https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore-compat.js"></script>
Init: firebase.initializeApp({ apiKey: '/* FIREBASE_API_KEY */', authDomain: '/* FIREBASE_AUTH_DOMAIN */', projectId: '/* FIREBASE_PROJECT_ID */' });
      const db = firebase.firestore();
Read: const snap = await db.collection('items').get(); snap.forEach(doc => console.log(doc.data()));
Write: await db.collection('items').add({ name: 'value', createdAt: firebase.firestore.Timestamp.now() });`,
  },
  {
    name: "OpenAI",
    keyPatterns: [/openai/i, /OPENAI/i],
    usageBlock: `INTEGRATION — OpenAI API:
Note: OpenAI API keys must NEVER be embedded in frontend HTML/JS — they would be publicly visible.
Instead: show a placeholder UI with a note "This feature requires a server-side API call" and mark it in integrationsNeeded.
If building a demo, simulate AI responses with setTimeout and hardcoded example outputs.`,
  },
  {
    name: "Mailchimp / Email Marketing",
    keyPatterns: [/mailchimp/i, /MAILCHIMP/i, /sendgrid/i, /SENDGRID/i],
    usageBlock: `INTEGRATION — Email Marketing (Mailchimp/SendGrid):
Note: Email API keys must NEVER appear in frontend code.
For newsletter signup forms: collect email client-side, show success state, mark integrationsNeeded.
Use a placeholder fetch: fetch('/api/subscribe', { method: 'POST', body: JSON.stringify({ email }) }) and handle the response gracefully.`,
  },
  {
    name: "Supabase",
    keyPatterns: [/supabase/i, /SUPABASE/i],
    usageBlock: `INTEGRATION — Supabase:
CDN: <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
Init: const { createClient } = supabase; const sb = createClient('/* SUPABASE_URL */', '/* SUPABASE_ANON_KEY */');
Read: const { data, error } = await sb.from('table_name').select('*');
Insert: const { data, error } = await sb.from('table_name').insert([{ column: 'value' }]);
Note: Use anon key (public) — never the service_role key in frontend code.`,
  },
];

/**
 * Load project secrets and build an integration-aware context block for the AI prompt.
 * Matches secret key names against the integration catalog to inject precise usage instructions.
 */
async function loadIntegrationContext(projectId: number): Promise<string> {
  try {
    const secrets = await db
      .select({ name: secretsTable.name, category: secretsTable.category })
      .from(secretsTable)
      .where(eq(secretsTable.projectId, projectId));

    if (secrets.length === 0) return "";

    const secretNames = secrets.map((s) => s.name);
    const matchedIntegrations: string[] = [];

    for (const integration of INTEGRATION_CATALOG) {
      const isConnected = secretNames.some((name) =>
        integration.keyPatterns.some((pattern) => pattern.test(name)),
      );
      if (isConnected) {
        matchedIntegrations.push(integration.usageBlock);
      }
    }

    if (matchedIntegrations.length === 0) return "";

    return `CONNECTED INTEGRATIONS — use these exact patterns when implementing integration features:\n\n${matchedIntegrations.join("\n\n")}`;
  } catch (err) {
    logger.warn({ err, projectId }, "Failed to load integration context — non-fatal");
    return "";
  }
}

async function generateFixSuggestions(
  userPrompt: string,
  errorMessage: string,
): Promise<string[]> {
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
async function maybeEscalateWarnings(
  projectId: number,
  currentWarnings: string[],
): Promise<void> {
  if (currentWarnings.length === 0) return;
  try {
    const prevTasks = await db
      .select({ report: agentTasksTable.report })
      .from(agentTasksTable)
      .where(
        and(
          eq(agentTasksTable.projectId, projectId),
          eq(agentTasksTable.status, "completed"),
        ),
      )
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

/**
 * Write a proactive build pattern lesson to the Knowledge Vault.
 * Called after every successful build/refine (not just failures) so the vault
 * grows with positive knowledge about what works.
 */
async function writeSuccessLesson(opts: {
  kind: JobKind;
  userPrompt: string;
  assistantSummary: string;
  report: TaskReport;
  projectId: number;
  userId?: string;
  taskId: number;
  versionId?: number | null;
}): Promise<void> {
  const { kind, userPrompt, assistantSummary, report, projectId, userId, taskId, versionId } = opts;
  const integrationNames = report.integrationsNeeded?.map((i) => i.name) ?? [];
  const integrationNote = integrationNames.length > 0
    ? ` Integrations referenced: ${integrationNames.join(", ")}.`
    : "";
  const warningNote = (report.warnings?.length ?? 0) > 0
    ? ` Warnings: ${report.warnings!.slice(0, 2).join("; ")}.`
    : "";

  await writeKnowledge({
    title: `${kind === "build" ? "Build" : "Refinement"} pattern: "${userPrompt.slice(0, 50)}"`,
    category: kind === "build" ? "build" : "refinement",
    content: `${assistantSummary.slice(0, 300)}${integrationNote}${warningNote} Files: created=${report.filesCreated.length}, changed=${report.filesChanged.length}, removed=${report.filesRemoved.length}.`,
    type: "build_pattern",
    severity: "info",
    projectId,
    userId,
    relatedTaskId: taskId,
    relatedVersionId: versionId ?? undefined,
    tags: integrationNames,
  });
}

export async function runJob(input: JobInput): Promise<void> {
  const { taskId, projectId, kind, userPrompt, agentMode, conversationHistory } = input;

  // Convenience wrapper: emit an event and return a promise for use as onEvent callback
  const emit = (type: string, message: string, filePath?: string) =>
    emitEvent(taskId, type, message, filePath);

  await emit("queued", "Task received, starting pipeline…");

  await db
    .update(agentTasksTable)
    .set({ status: kind === "build" ? "building" : "planning" })
    .where(eq(agentTasksTable.id, taskId));

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));
  if (!project) {
    await emit("failed", "Project not found.");
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

  // ── Mobile generation lock ────────────────────────────────────────────────
  const MOBILE_KINDS = ["mobile-ios", "mobile-android"];
  if (MOBILE_KINDS.includes(project.kind)) {
    const msg =
      "Mobile generation is not enabled yet. MustaFlow AI currently supports static web apps only.";
    await emit("failed", msg);
    await db
      .update(agentTasksTable)
      .set({ status: "failed", result: msg, completedAt: sql`now()` })
      .where(eq(agentTasksTable.id, taskId));
    return;
  }

  // --- Credit pre-flight: fail fast if user cannot afford this AI call ---
  const creditCost = CREDIT_COST[agentMode] ?? 1;
  if (project.ownerId) {
    const credits = await getOrCreateCredits(project.ownerId);
    if (credits.balance < creditCost) {
      const msg = `Insufficient credits. This ${agentMode} build costs ${creditCost} credit(s) but your balance is ${credits.balance}. Top up in Billing to continue.`;
      await emit("failed", msg);
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

    // Step 1: Analyse request
    await emit("analyzing_request", "Analysing your request…");

    // Step 2: Load context (knowledge + integrations)
    await emit("loading_context", "Loading knowledge and integration context…");
    const [knowledgeContext, integrationContext] = await Promise.all([
      loadKnowledgeContext(projectId, userPrompt),
      loadIntegrationContext(projectId),
    ]);

    if (kind === "build") {
      await emit("planning_changes", "Planning file structure and approach…");

      // onEvent bridge: forward pipeline events to the task event stream
      const onEvent = (type: string, message: string) => emit(type, message);

      const result = await runBuildPipeline({
        projectName: project.name,
        projectKind: project.kind,
        userPrompt,
        agentMode,
        conversationHistory,
        knowledgeContext: knowledgeContext || undefined,
        integrationContext: integrationContext || undefined,
        onEvent,
      });

      await emit(
        "generating_code",
        `Blueprint created: ${result.files.length} file(s) planned.`,
      );

      await emit("saving_files", "Writing generated files…");
      for (const f of result.files) {
        await emit("saving_files", `Writing ${f.path}`, f.path);
      }
      await writeFiles(projectId, result.files, true);

      report = result.report;
      assistantSummary = result.assistantSummary;
      nextVersionLabel = "Initial build";
    } else {
      await emit("reading_files", "Reading current project files…");
      const existingFiles = await loadFiles(projectId);
      await emit(
        "reading_files",
        `Loaded ${existingFiles.length} existing file(s).`,
      );

      await emit("planning_changes", "Planning changes…");

      const onEvent = (type: string, message: string) => emit(type, message);

      const result = await runRefinePipeline({
        projectName: project.name,
        projectKind: project.kind,
        userPrompt,
        agentMode,
        existingFiles,
        conversationHistory,
        knowledgeContext: knowledgeContext || undefined,
        integrationContext: integrationContext || undefined,
        onEvent,
      });

      await emit(
        "generating_code",
        `AI returned ${result.changedFiles.length} changed file(s).`,
      );

      await emit("saving_files", "Writing changed files…");
      if (result.changedFiles.length > 0) {
        for (const f of result.changedFiles) {
          await emit("saving_files", `Updating ${f.path}`, f.path);
        }
        await writeFiles(projectId, result.changedFiles, false);
      }
      if (result.removedPaths.length > 0) {
        for (const p of result.removedPaths) {
          await emit("saving_files", `Removing ${p}`, p);
        }
        await deleteFiles(projectId, result.removedPaths);
      }

      report = result.report;
      assistantSummary = result.assistantSummary;
      nextVersionLabel = userPrompt.slice(0, 40) || "Refinement";
    }

    await emit("saving_version", "Saving version rollback point…");
    const snapshot = await snapshotFilesForVersion(projectId);
    const [version] = await db
      .insert(projectVersionsTable)
      .values({
        projectId,
        label: nextVersionLabel,
        note: assistantSummary.slice(0, 200),
        filesSnapshot: snapshot,
      })
      .returning();
    report.versionId = version?.id ?? null;

    await emit("updating_preview", "Refreshing preview…");

    await db
      .update(agentTasksTable)
      .set({
        status: "completed",
        result: assistantSummary,
        report,
        completedAt: sql`now()`,
      })
      .where(eq(agentTasksTable.id, taskId));

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

    await emit("completed", "Task completed.");

    // --- Deduct credits after a successful AI build/refine ---
    if (project.ownerId) {
      void deductCredits(project.ownerId, creditCost, {
        type: kind,
        description: `${kind === "build" ? "Build" : "Refine"} (${agentMode}) — project ${projectId}`,
        projectId,
      }).catch((err) => logger.warn({ err }, "Credit deduction failed (non-fatal)"));
    }

    // Fire-and-forget: write lessons to the knowledge vault
    await emit("writing_lessons", "Writing lessons to Knowledge Vault…");
    void maybeEscalateWarnings(projectId, report.warnings ?? []);
    void writeSuccessLesson({
      kind,
      userPrompt,
      assistantSummary,
      report,
      projectId,
      userId: project.ownerId,
      taskId,
      versionId: version?.id,
    });

    // Append a system message so the chat shows the report was produced
    await db.insert(chatMessagesTable).values({
      projectId,
      role: "system",
      content: assistantSummary,
      agentMode,
      planMode: false,
      plan: { kind: "report", report } as unknown as Record<string, unknown>,
    });
  } catch (err) {
    logger.error({ err, taskId, projectId }, "Builder job failed");
    const message =
      err instanceof Error ? err.message : "Unknown builder error";
    await emit("failed", message);

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
      .set({ report: { userRequest: userPrompt, filesCreated: [], filesChanged: [], filesRemoved: [], previewUpdated: false, warnings: [], suggestions, integrationsNeeded: [] } })
      .where(eq(agentTasksTable.id, taskId));

    // Auto-write a diagnostic lesson to the Knowledge Vault
    void autoWriteFailureLesson(userPrompt, message, projectId, project.ownerId);

    // Post a rich error message with suggestions into the chat
    try {
      await db.insert(chatMessagesTable).values({
        projectId,
        role: "assistant",
        content: `Build failed: ${message}`,
        agentMode,
        planMode: false,
        plan: { kind: "error", message, suggestions } as unknown as Record<string, unknown>,
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
