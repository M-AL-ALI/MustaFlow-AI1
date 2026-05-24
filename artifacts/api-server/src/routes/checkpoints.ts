/**
 * Unified Checkpoints (Task #538)
 *
 * Restores a project to a previous checkpoint (project_versions row) in one
 * atomic-ish flow:
 *
 *   1) Snapshot the CURRENT state into a forward-checkpoint version (so the
 *      user can undo the restore). DB snapshot is captured best-effort.
 *   2) Restore files from the target version.
 *   3) Restore the linked database snapshot if one exists.
 *   4) Truncate chat history after the anchored message — everything that came
 *      after the checkpoint is removed.
 *
 * Safety: forward-checkpoint runs first. If it fails (rare), the restore is
 * aborted so the user can't lose unrecoverable state.
 */
import { Router, type IRouter } from "express";
import { and, desc, eq, gt, or, sql } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectVersionsTable,
  projectFilesTable,
  chatMessagesTable,
  dbSnapshotsTable,
  secretsTable,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { encryptionService } from "../lib/encryption";
import { logger } from "../lib/logger";
import { restorePostgresDump, restoreSQLiteSnapshot } from "../lib/db-snapshot-restore";
import { downloadSnapshotBlob } from "../lib/snapshot-storage";
import { captureProjectDbSnapshot } from "../lib/db-snapshot-capture";

const router: IRouter = Router();

interface SnapshotFile {
  path: string;
  content: string;
  mimeType?: string;
}

router.get(
  "/projects/:id/checkpoints",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    // Use a lateral subquery to pick the LATEST db snapshot per version so a
    // version with multiple snapshots doesn't appear as duplicate rows.
    // Pulls each version plus:
    //   • latest linked db snapshot (provider + total byte size)
    //   • the most recent USER chat message anchored to this checkpoint
    //     (so the timeline can show "what prompt produced this checkpoint")
    const rows = await db.execute<{
      id: number;
      project_id: number;
      label: string | null;
      note: string | null;
      created_at: Date;
      files_count: number;
      db_snapshot_id: number | null;
      db_provider: string | null;
      db_snapshot_size_bytes: number | null;
      trigger_message_id: number | null;
      trigger_message_preview: string | null;
    }>(sql`
      SELECT v.id,
             v.project_id,
             v.label,
             v.note,
             v.created_at,
             COALESCE(jsonb_array_length(v.files_snapshot), 0) AS files_count,
             s.id AS db_snapshot_id,
             s.provider AS db_provider,
             s.size_bytes AS db_snapshot_size_bytes,
             m.id AS trigger_message_id,
             m.preview AS trigger_message_preview
      FROM ${projectVersionsTable} v
      LEFT JOIN LATERAL (
        SELECT id, provider, size_bytes
        FROM ${dbSnapshotsTable}
        WHERE project_id = v.project_id AND version_id = v.id
        ORDER BY created_at DESC
        LIMIT 1
      ) s ON TRUE
      LEFT JOIN LATERAL (
        SELECT id, LEFT(content, 200) AS preview
        FROM ${chatMessagesTable}
        WHERE project_id = v.project_id
          AND checkpoint_id = v.id
          AND role = 'user'
        ORDER BY created_at DESC
        LIMIT 1
      ) m ON TRUE
      WHERE v.project_id = ${projectId}
      ORDER BY v.created_at DESC
    `);

    const list = (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]);
    res.json(
      (list as Array<Record<string, unknown>>).map((r) => ({
        id: Number(r.id),
        projectId: Number(r.project_id),
        label: (r.label as string | null) ?? "",
        note: (r.note as string | null) ?? null,
        createdAt:
          r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? ""),
        filesCount: Number(r.files_count ?? 0),
        hasDbSnapshot: r.db_snapshot_id != null,
        dbProvider: (r.db_provider as string | null) ?? null,
        dbSnapshotSizeBytes:
          r.db_snapshot_size_bytes != null ? Number(r.db_snapshot_size_bytes) : null,
        triggerMessageId: r.trigger_message_id != null ? Number(r.trigger_message_id) : null,
        triggerMessagePreview: (r.trigger_message_preview as string | null) ?? null,
      })),
    );
  },
);

router.post(
  "/projects/:id/checkpoints/:checkpointId/restore",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const checkpointId = Number(req.params.checkpointId);
    if (!Number.isInteger(projectId) || !Number.isInteger(checkpointId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const [target] = await db
      .select()
      .from(projectVersionsTable)
      .where(
        and(
          eq(projectVersionsTable.id, checkpointId),
          eq(projectVersionsTable.projectId, projectId),
        ),
      );
    if (!target) {
      res.status(404).json({ error: "Checkpoint not found" });
      return;
    }
    if (!Array.isArray(target.filesSnapshot)) {
      res.status(400).json({ error: "Checkpoint snapshot is missing or corrupted" });
      return;
    }
    const targetSnapshot = target.filesSnapshot as SnapshotFile[];

    // ── 1) Forward checkpoint: snapshot the CURRENT state first ────────────
    let forwardCheckpointId: number | null = null;
    try {
      const currentFiles = await db
        .select({
          path: projectFilesTable.path,
          content: projectFilesTable.content,
          mimeType: projectFilesTable.mimeType,
        })
        .from(projectFilesTable)
        .where(eq(projectFilesTable.projectId, projectId));

      const [forward] = await db
        .insert(projectVersionsTable)
        .values({
          projectId,
          label: `Before rewind to "${target.label}"`,
          note: `Auto-checkpoint created before restoring checkpoint #${checkpointId}`,
          changelogEntry: "Auto-checkpoint (pre-rewind safety snapshot)",
          filesSnapshot: currentFiles.map((f) => ({
            path: f.path,
            content: f.content,
            mimeType: f.mimeType ?? "text/plain",
          })),
        })
        .returning({ id: projectVersionsTable.id });
      forwardCheckpointId = forward?.id ?? null;

      if (forwardCheckpointId) {
        // best-effort DB snapshot of current state
        await captureProjectDbSnapshot(projectId, forwardCheckpointId, `Pre-rewind auto-snapshot`);
      }
    } catch (err) {
      req.log.error(
        { err, projectId, checkpointId },
        "Forward checkpoint failed; aborting restore",
      );
      res
        .status(500)
        .json({ error: "Failed to create safety snapshot before restore. Restore aborted." });
      return;
    }

    // ── 2) Restore linked DB snapshot FIRST (external/non-transactional) ──
    // We do DB restore before touching files/chat. If it fails, we abort
    // before mutating the project so the user is never left with code+chat
    // rewound but DB not. The forward safety checkpoint is preserved either
    // way so the user can manually recover if needed.
    let dbSnapshotRestored = false;
    let dbSnapshotError: string | null = null;
    let dbSnapshotAttempted = false;
    try {
      const [linkedSnapshot] = await db
        .select()
        .from(dbSnapshotsTable)
        .where(
          and(
            eq(dbSnapshotsTable.projectId, projectId),
            eq(dbSnapshotsTable.versionId, checkpointId),
          ),
        )
        .orderBy(desc(dbSnapshotsTable.createdAt))
        .limit(1);

      if (linkedSnapshot) {
        dbSnapshotAttempted = true;
        const dumpContent =
          (await downloadSnapshotBlob(linkedSnapshot.objectKey)) ?? linkedSnapshot.dumpContent;
        if (!dumpContent) {
          dbSnapshotError = "Database snapshot content is missing from storage.";
        } else if (linkedSnapshot.provider === "postgres") {
          const [secretRow] = await db
            .select()
            .from(secretsTable)
            .where(
              and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, "DATABASE_URL")),
            );
          if (!secretRow) {
            dbSnapshotError = "DATABASE_URL secret not found — DB restore skipped.";
          } else {
            const connectionString = encryptionService.decrypt(secretRow.valueEncrypted);
            if (!connectionString || connectionString.includes("localhost:5432")) {
              dbSnapshotError = "DATABASE_URL is a placeholder — DB restore skipped.";
            } else {
              await restorePostgresDump(connectionString, dumpContent);
              dbSnapshotRestored = true;
            }
          }
        } else if (linkedSnapshot.provider === "sqlite") {
          const [proj] = await db
            .select({
              containerId: projectsTable.containerId,
              containerStatus: projectsTable.containerStatus,
            })
            .from(projectsTable)
            .where(eq(projectsTable.id, projectId));
          if (!proj?.containerId || proj.containerStatus !== "running") {
            dbSnapshotError = "SQLite restore requires an active container — DB restore skipped.";
          } else {
            await restoreSQLiteSnapshot(proj.containerId, dumpContent, projectId);
            dbSnapshotRestored = true;
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      dbSnapshotError = `Database restore failed: ${message}`;
      logger.error({ err, projectId, checkpointId }, "Checkpoint DB restore failed");
    }

    // Abort if a DB snapshot was attached but the restore failed — keeps
    // code+chat+db in a consistent state. Forward checkpoint is preserved.
    if (dbSnapshotAttempted && !dbSnapshotRestored) {
      res.status(500).json({
        error: dbSnapshotError ?? "Database restore failed",
        forwardCheckpointId,
        aborted: true,
      });
      return;
    }

    // ── 3) Restore files + truncate chat (transactional) ─────────────────
    let truncatedMessages = 0;
    try {
      await db.transaction(async (tx) => {
        await tx.delete(projectFilesTable).where(eq(projectFilesTable.projectId, projectId));
        if (targetSnapshot.length > 0) {
          await tx.insert(projectFilesTable).values(
            targetSnapshot.map((f) => ({
              projectId,
              path: f.path,
              content: f.content,
              mimeType: f.mimeType,
            })),
          );
        }

        // Truncate chat by anchor message id when available; fall back to
        // version createdAt only if no anchor message exists.
        const [anchor] = await tx
          .select({ id: chatMessagesTable.id, createdAt: chatMessagesTable.createdAt })
          .from(chatMessagesTable)
          .where(
            and(
              eq(chatMessagesTable.projectId, projectId),
              eq(chatMessagesTable.checkpointId, checkpointId),
            ),
          )
          .orderBy(chatMessagesTable.id)
          .limit(1);
        if (anchor) {
          const deleted = await tx
            .delete(chatMessagesTable)
            .where(
              and(eq(chatMessagesTable.projectId, projectId), gt(chatMessagesTable.id, anchor.id)),
            )
            .returning({ id: chatMessagesTable.id });
          truncatedMessages = deleted.length;
        } else if (target.createdAt) {
          const cutoff = target.createdAt;
          const deleted = await tx
            .delete(chatMessagesTable)
            .where(
              or(
                and(
                  eq(chatMessagesTable.projectId, projectId),
                  gt(chatMessagesTable.createdAt, cutoff),
                ),
              )!,
            )
            .returning({ id: chatMessagesTable.id });
          truncatedMessages = deleted.length;
        }
      });
    } catch (err) {
      req.log.error({ err, projectId, checkpointId }, "Checkpoint restore transaction failed");
      res.status(500).json({
        error: "Failed to restore files and chat history. No changes were applied.",
        forwardCheckpointId,
      });
      return;
    }

    // Invalidate semantic search embeddings (best-effort)
    try {
      const { invalidateProjectEmbeddings } = await import("../lib/project-search");
      await invalidateProjectEmbeddings(projectId);
    } catch (err) {
      req.log.warn({ err, projectId }, "checkpoint restore: invalidate embeddings failed");
    }

    // ── 4) System message marker (lands AFTER truncation, so it stays) ────
    await db.insert(chatMessagesTable).values({
      projectId,
      role: "system",
      content: `Rewound to checkpoint "${target.label}" — ${targetSnapshot.length} files restored${
        dbSnapshotRestored ? ", database snapshot restored" : ""
      }${truncatedMessages > 0 ? `, ${truncatedMessages} later messages removed` : ""}. A safety checkpoint was created so you can undo.`,
      agentMode: "eco",
      planMode: false,
    });

    await db
      .update(projectsTable)
      .set({
        updatedAt: sql`now()`,
        status: "testing",
        lastTaskSummary: `Rewound to "${target.label}"`,
      })
      .where(eq(projectsTable.id, projectId));

    res.json({
      checkpointId,
      label: target.label,
      restoredFiles: targetSnapshot.length,
      truncatedMessages,
      forwardCheckpointId,
      dbSnapshotRestored,
      dbSnapshotError,
    });
  },
);

export default router;
