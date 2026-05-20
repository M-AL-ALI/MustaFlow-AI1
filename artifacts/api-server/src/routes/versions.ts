import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectVersionsTable,
  projectFilesTable,
  chatMessagesTable,
  knowledgeEntriesTable,
  agentTasksTable,
  taskEventsTable,
} from "@workspace/db";
import {
  ListVersionsParams,
  ListVersionsResponse,
  CreateVersionParams,
  CreateVersionBody,
} from "@workspace/api-zod";
import { requireProjectOwnership } from "../lib/auth";
import { guessMime } from "../lib/builder";
import { isBinaryMime } from "../lib/binary-mime";
import { injectBridge } from "../lib/consoleBridge";
import { logger } from "../lib/logger";

const router: IRouter = Router();

async function emitRollbackEvent(
  taskId: number,
  eventType: string,
  message: string,
): Promise<void> {
  try {
    await db.insert(taskEventsTable).values({ taskId, eventType, message, filePath: null });
  } catch (err) {
    logger.warn({ err, taskId, eventType }, "Failed to emit rollback task event");
  }
}

router.get("/projects/:id/versions", requireProjectOwnership, async (req, res): Promise<void> => {
  const params = ListVersionsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select({
      id: projectVersionsTable.id,
      projectId: projectVersionsTable.projectId,
      label: projectVersionsTable.label,
      note: projectVersionsTable.note,
      changelogEntry: projectVersionsTable.changelogEntry,
      filesCount: sql<number>`COALESCE(jsonb_array_length(${projectVersionsTable.filesSnapshot}), 0)`,
      createdAt: projectVersionsTable.createdAt,
      planSnapshot: projectVersionsTable.planSnapshot,
    })
    .from(projectVersionsTable)
    .where(eq(projectVersionsTable.projectId, params.data.id))
    .orderBy(desc(projectVersionsTable.createdAt));
  res.json(ListVersionsResponse.parse(rows));
});

router.post("/projects/:id/versions", requireProjectOwnership, async (req, res): Promise<void> => {
  const params = CreateVersionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateVersionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const projectId = params.data.id;

  const fileRows = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));

  const [v] = await db
    .insert(projectVersionsTable)
    .values({
      projectId,
      label: parsed.data.label,
      note: parsed.data.note ?? null,
      filesSnapshot: fileRows.map((r) => ({
        path: r.path,
        content: r.content,
        mimeType: r.mimeType,
      })),
    })
    .returning();
  res.status(201).json({
    id: v?.id,
    projectId,
    label: parsed.data.label,
    note: parsed.data.note ?? null,
    createdAt: v?.createdAt,
  });
});

router.get(
  "/projects/:id/versions/:versionId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const versionId = Number(req.params.versionId);
    if (!Number.isFinite(versionId)) {
      res.status(400).json({ error: "Invalid version id" });
      return;
    }
    const [version] = await db
      .select()
      .from(projectVersionsTable)
      .where(eq(projectVersionsTable.id, versionId));
    if (!version || version.projectId !== projectId) {
      res.status(404).json({ error: "Version not found" });
      return;
    }
    res.json({
      id: version.id,
      projectId: version.projectId,
      label: version.label,
      note: version.note ?? null,
      createdAt: version.createdAt,
      filesSnapshot: version.filesSnapshot ?? [],
    });
  },
);

// Serve a file from a specific version snapshot — used by the variant comparison iframes.
// Auth-checked: caller must own the project.
router.get(
  "/projects/:id/versions/:versionId/preview/{*splat}",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const versionId = Number(req.params.versionId);
    if (!Number.isFinite(versionId)) {
      res.status(400).json({ error: "Invalid version id" });
      return;
    }

    const [version] = await db
      .select({ filesSnapshot: projectVersionsTable.filesSnapshot, projectId: projectVersionsTable.projectId })
      .from(projectVersionsTable)
      .where(eq(projectVersionsTable.id, versionId));

    if (!version || version.projectId !== projectId) {
      res.status(404).type("text/html").send(
        `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Version not found</h1></body></html>`,
      );
      return;
    }

    type SnapshotFile = { path: string; content: string; mimeType?: string };
    const snapshot = (version.filesSnapshot ?? []) as SnapshotFile[];

    const splat = req.params.splat;
    const raw = Array.isArray(splat) ? splat.join("/") : (splat ?? "");
    const filePath = raw === "" ? "index.html" : raw;

    let file = snapshot.find((f) => f.path === filePath);
    if (!file) file = snapshot.find((f) => f.path === "index.html");

    if (!file) {
      res.status(404).type("text/html").send(
        `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">No preview yet</h1></body></html>`,
      );
      return;
    }

    const mime = file.mimeType || guessMime(file.path);
    const isHtml = mime === "text/html" || file.path.endsWith(".html");
    res.type(mime).setHeader("Cache-Control", "no-store, must-revalidate");
    if (isBinaryMime(mime)) {
      res.end(Buffer.from(file.content, "base64"));
    } else {
      res.send(isHtml ? injectBridge(file.content) : file.content);
    }
  },
);

router.post(
  "/projects/:id/versions/:versionId/rollback",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const versionId = Number(req.params.versionId);
    if (!Number.isFinite(versionId)) {
      res.status(400).json({ error: "Invalid version id" });
      return;
    }

    const [version] = await db
      .select()
      .from(projectVersionsTable)
      .where(eq(projectVersionsTable.id, versionId));
    if (!version || version.projectId !== projectId) {
      res.status(404).json({ error: "Version not found" });
      return;
    }
    const snapshot = version.filesSnapshot ?? [];

    // Create a rollback task row so it appears in Build History with live events
    const [rollbackTask] = await db
      .insert(agentTasksTable)
      .values({
        projectId,
        title: `Rollback to "${version.label}"`,
        kind: "rollback",
        status: "planning",
        prompt: `Restore project to version: ${version.label}`,
      })
      .returning();
    const taskId = rollbackTask?.id ?? 0;

    await emitRollbackEvent(taskId, "queued", "Rollback initiated…");
    await emitRollbackEvent(
      taskId,
      "restoring_files",
      `Restoring ${snapshot.length} file(s) from version "${version.label}"…`,
    );

    // Bulk delete current files and re-insert snapshot
    await db.delete(projectFilesTable).where(eq(projectFilesTable.projectId, projectId));
    if (snapshot.length > 0) {
      await db.insert(projectFilesTable).values(
        snapshot.map((f) => ({
          projectId,
          path: f.path,
          content: f.content,
          mimeType: f.mimeType,
        })),
      );
    }

    await emitRollbackEvent(taskId, "updating_preview", "Refreshing preview with restored files…");

    await db.insert(chatMessagesTable).values({
      projectId,
      role: "system",
      content: `Rolled back to version "${version.label}" (${snapshot.length} files restored).`,
      agentMode: "eco",
      planMode: false,
    });

    await db
      .update(projectsTable)
      .set({
        updatedAt: sql`now()`,
        status: "testing",
        lastTaskSummary: `Rolled back to "${version.label}"`,
      })
      .where(eq(projectsTable.id, projectId));

    await emitRollbackEvent(taskId, "completed", "Rollback complete.");

    if (rollbackTask) {
      await db
        .update(agentTasksTable)
        .set({
          status: "completed",
          result: `Rolled back to "${version.label}"`,
          completedAt: sql`now()`,
        })
        .where(eq(agentTasksTable.id, rollbackTask.id));
    }

    // Write a rollback signal to the Knowledge Vault so the AI can learn from it
    try {
      await db.insert(knowledgeEntriesTable).values({
        title: `Rollback to "${version.label}"`,
        category: "diagnostic",
        content: `User rolled back to version "${version.label}" (${snapshot.length} files). The subsequent build may have had issues worth addressing differently next time.`,
      });
    } catch {
      // best-effort — don't fail the rollback if knowledge write fails
    }

    res.json({
      restoredFiles: snapshot.length,
      versionId,
      label: version.label,
      taskId: rollbackTask?.id ?? null,
    });
  },
);

export default router;
