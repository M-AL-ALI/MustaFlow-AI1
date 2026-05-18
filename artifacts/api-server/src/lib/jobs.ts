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

async function loadKnowledgeContext(projectId: number): Promise<string> {
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
      .orderBy(knowledgeEntriesTable.createdAt)
      .limit(40);
    if (entries.length === 0) return "";
    return entries
      .map((e) => `[${e.category}] ${e.title}: ${e.content}`)
      .join("\n");
  } catch {
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

export async function runJob(input: JobInput): Promise<void> {
  const { taskId, projectId, kind, userPrompt, agentMode, conversationHistory } = input;

  await emitEvent(taskId, "queued", "Task received, starting pipeline…");

  await db
    .update(agentTasksTable)
    .set({ status: kind === "build" ? "building" : "planning" })
    .where(eq(agentTasksTable.id, taskId));

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));
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

  // ── Mobile generation lock ────────────────────────────────────────────────
  const MOBILE_KINDS = ["mobile-ios", "mobile-android"];
  if (MOBILE_KINDS.includes(project.kind)) {
    const msg =
      "Mobile generation is not enabled yet. MustaFlow AI currently supports static web apps only.";
    await emitEvent(taskId, "failed", msg);
    await db
      .update(agentTasksTable)
      .set({ status: "failed", result: msg, completedAt: sql`now()` })
      .where(eq(agentTasksTable.id, taskId));
    return;
  }

  const knowledgeContext = await loadKnowledgeContext(projectId);

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

    if (kind === "build") {
      await emitEvent(taskId, "planning", "Reading project configuration…");
      await emitEvent(
        taskId,
        "generating_code",
        "Generating app blueprint and code with AI…",
      );

      const result = await runBuildPipeline({
        projectName: project.name,
        projectKind: project.kind,
        userPrompt,
        agentMode,
        conversationHistory,
        knowledgeContext: knowledgeContext || undefined,
      });

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

      report = result.report;
      assistantSummary = result.assistantSummary;
      nextVersionLabel = "Initial build";
    } else {
      await emitEvent(taskId, "reading_files", "Reading current project files…");
      const existingFiles = await loadFiles(projectId);
      await emitEvent(
        taskId,
        "reading_files",
        `Loaded ${existingFiles.length} existing file(s).`,
      );

      await emitEvent(
        taskId,
        "generating_code",
        "Applying change request with AI…",
      );

      const result = await runRefinePipeline({
        projectName: project.name,
        projectKind: project.kind,
        userPrompt,
        agentMode,
        existingFiles,
        conversationHistory,
        knowledgeContext: knowledgeContext || undefined,
      });

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
            `Updating ${f.path}`,
            f.path,
          );
        }
        await writeFiles(projectId, result.changedFiles, false);
      }
      if (result.removedPaths.length > 0) {
        for (const p of result.removedPaths) {
          await emitEvent(taskId, "editing_files", `Removing ${p}`, p);
        }
        await deleteFiles(projectId, result.removedPaths);
      }

      report = result.report;
      assistantSummary = result.assistantSummary;
      nextVersionLabel = userPrompt.slice(0, 40) || "Refinement";
    }

    await emitEvent(
      taskId,
      "saving_version",
      "Saving version rollback point…",
    );
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

    await emitEvent(taskId, "completed", "Task completed.");

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
    void writeKnowledge({
      title: `${kind === "build" ? "Build" : "Refinement"} completed: "${userPrompt.slice(0, 60)}"`,
      content: `${assistantSummary.slice(0, 400)} — Files created: ${report.filesCreated.length}, changed: ${report.filesChanged.length}, removed: ${report.filesRemoved.length}. Warnings: ${report.warnings?.length ?? 0}.`,
      type: kind,
      category: kind === "build" ? "build" : "refinement",
      severity: (report.warnings?.length ?? 0) > 0 ? "warning" : "info",
      projectId,
      userId: project.ownerId,
      relatedTaskId: taskId,
      relatedVersionId: version?.id,
      tags: report.integrationsNeeded?.map((i) => i.name),
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
