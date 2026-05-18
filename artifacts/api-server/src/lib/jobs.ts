import { eq, sql } from "drizzle-orm";
import {
  db,
  projectsTable,
  agentTasksTable,
  projectFilesTable,
  projectVersionsTable,
  chatMessagesTable,
  taskEventsTable,
  type TaskReport,
  type FileSnapshotEntry,
} from "@workspace/db";
import {
  runBuildPipeline,
  runRefinePipeline,
  type BuilderFile,
  type ConversationTurn,
} from "./builder";
import type { AgentMode } from "./ai";
import { logger } from "./logger";

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

async function writeFiles(
  projectId: number,
  files: BuilderFile[],
  replaceAll: boolean,
): Promise<void> {
  if (replaceAll) {
    await db
      .delete(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId));
  }
  for (const f of files) {
    if (!replaceAll) {
      await db
        .delete(projectFilesTable)
        .where(
          sql`${projectFilesTable.projectId} = ${projectId} AND ${projectFilesTable.path} = ${f.path}`,
        );
    }
    await db.insert(projectFilesTable).values({
      projectId,
      path: f.path,
      content: f.content,
      mimeType: f.mimeType,
    });
  }
}

async function deleteFiles(
  projectId: number,
  paths: string[],
): Promise<void> {
  for (const p of paths) {
    await db
      .delete(projectFilesTable)
      .where(
        sql`${projectFilesTable.projectId} = ${projectId} AND ${projectFilesTable.path} = ${p}`,
      );
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

    await db
      .update(projectsTable)
      .set({
        status: "testing",
        lastTaskSummary: assistantSummary.slice(0, 140),
        updatedAt: sql`now()`,
      })
      .where(eq(projectsTable.id, projectId));

    await emitEvent(taskId, "completed", "Task completed.");

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
    await db
      .update(agentTasksTable)
      .set({
        status: "failed",
        result: message,
        completedAt: sql`now()`,
      })
      .where(eq(agentTasksTable.id, taskId));
    await db
      .update(projectsTable)
      .set({ status: "failed", updatedAt: sql`now()` })
      .where(eq(projectsTable.id, projectId));

    // Post a visible error message into the chat
    try {
      await db.insert(chatMessagesTable).values({
        projectId,
        role: "assistant",
        content: `Build failed: ${message}`,
        agentMode,
        planMode: false,
        plan: { kind: "error", message } as unknown as Record<string, unknown>,
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
