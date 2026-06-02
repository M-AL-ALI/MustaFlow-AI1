import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectVersionsTable,
  projectFilesTable,
  chatMessagesTable,
  knowledgeEntriesTable,
  agentTasksTable,
  taskEventsTable,
  secretsTable,
  dbSnapshotsTable,
  projectActivityTable,
} from "@workspace/db";
import {
  ListVersionsParams,
  CreateVersionParams,
  CreateVersionBody,
  PatchVersionParams,
  PatchVersionBody,
} from "@workspace/api-zod";
import { requireProjectAccess } from "../lib/auth";
import { guessMime } from "../lib/builder";
import { isBinaryMime } from "../lib/binary-mime";
import { injectBridge } from "../lib/consoleBridge";
import { logger } from "../lib/logger";
import { deployProductionContainer } from "../lib/container";
import { encryptionService } from "../lib/encryption";
import { restorePostgresDump, restoreSQLiteSnapshot } from "../lib/db-snapshot-restore";
import { downloadSnapshotBlob } from "../lib/snapshot-storage";

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

router.get(
  "/projects/:id/versions",
  requireProjectAccess("viewer"),
  async (req, res): Promise<void> => {
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
        testingApprovedAt: projectVersionsTable.testingApprovedAt,
        testingApprovedBy: projectVersionsTable.testingApprovedBy,
        migrationStatus: projectVersionsTable.migrationStatus,
        testingSkipped: projectVersionsTable.testingSkipped,
      })
      .from(projectVersionsTable)
      .where(eq(projectVersionsTable.projectId, params.data.id))
      .orderBy(desc(projectVersionsTable.createdAt));
    res.json(rows);
  },
);

router.patch(
  "/projects/:id/versions/:versionId",
  requireProjectAccess("member"),
  async (req, res): Promise<void> => {
    const params = PatchVersionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = PatchVersionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const updates: Partial<typeof projectVersionsTable.$inferInsert> = {};
    if (parsed.data.label !== undefined) updates.label = parsed.data.label;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const [updated] = await db
      .update(projectVersionsTable)
      .set(updates)
      .where(
        and(
          eq(projectVersionsTable.id, params.data.versionId),
          eq(projectVersionsTable.projectId, params.data.id),
        ),
      )
      .returning({
        id: projectVersionsTable.id,
        projectId: projectVersionsTable.projectId,
        label: projectVersionsTable.label,
        note: projectVersionsTable.note,
        changelogEntry: projectVersionsTable.changelogEntry,
        filesCount: sql<number>`COALESCE(jsonb_array_length(${projectVersionsTable.filesSnapshot}), 0)`,
        createdAt: projectVersionsTable.createdAt,
        planSnapshot: projectVersionsTable.planSnapshot,
      });

    if (!updated) {
      res.status(404).json({ error: "Version not found" });
      return;
    }

    res.json(updated);
  },
);

router.post(
  "/projects/:id/versions",
  requireProjectAccess("member"),
  async (req, res): Promise<void> => {
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
  },
);

router.get(
  "/projects/:id/versions/:versionId",
  requireProjectAccess("viewer"),
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
  requireProjectAccess("viewer"),
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const versionId = Number(req.params.versionId);
    if (!Number.isFinite(versionId)) {
      res.status(400).json({ error: "Invalid version id" });
      return;
    }

    const [version] = await db
      .select({
        filesSnapshot: projectVersionsTable.filesSnapshot,
        projectId: projectVersionsTable.projectId,
      })
      .from(projectVersionsTable)
      .where(eq(projectVersionsTable.id, versionId));

    if (!version || version.projectId !== projectId) {
      res
        .status(404)
        .type("text/html")
        .send(
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
      res
        .status(404)
        .type("text/html")
        .send(
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
  requireProjectAccess("member"),
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const versionId = Number(req.params.versionId);
    if (!Number.isFinite(versionId)) {
      res.status(400).json({ error: "Invalid version id" });
      return;
    }

    const { restoreDb } = (req.body ?? {}) as { restoreDb?: boolean };

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

    // Invalidate the per-project semantic-search index — restored files may
    // have stale embeddings keyed to the prior content hashes. Best-effort,
    // non-fatal: the next semantic_search call would re-hash and re-embed
    // anyway, but eager invalidation prevents stale top-k rows from briefly
    // crowding out current results.
    try {
      const { invalidateProjectEmbeddings } = await import("../lib/project-search");
      await invalidateProjectEmbeddings(projectId);
    } catch (err) {
      req.log.warn({ err, projectId }, "rollback: invalidate embeddings failed (non-fatal)");
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

    // Log rollback to the project activity feed
    try {
      await db.insert(projectActivityTable).values({
        projectId,
        actorId: req.userId ?? null,
        actorName: null,
        eventType: "rollback",
        summary: `Rolled back to version "${version.label}"`,
        metadata: { versionId, label: version.label },
      });
    } catch (err) {
      req.log.warn({ err, projectId }, "Failed to log rollback activity (non-fatal)");
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

    // Phase E: best-effort prod container redeploy from the rolled-back snapshot.
    // Non-fatal — if this fails the rollback still succeeds (DB files are already restored).
    const [currentProject] = await db
      .select({
        prodContainerId: projectsTable.prodContainerId,
        projectFormat: projectsTable.projectFormat,
        status: projectsTable.status,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));

    if (
      currentProject?.prodContainerId &&
      currentProject.projectFormat === "react-vite" &&
      currentProject.status === "published" &&
      process.env.FLY_API_TOKEN
    ) {
      setImmediate(() => {
        void (async () => {
          try {
            const secretRows = await db
              .select({ name: secretsTable.name, valueEncrypted: secretsTable.valueEncrypted })
              .from(secretsTable)
              .where(eq(secretsTable.projectId, projectId));

            const envVars: Record<string, string> = {
              PROJECT_ID: String(projectId),
              NODE_ENV: "production",
              PORT: "3000",
            };
            for (const s of secretRows) {
              try {
                envVars[s.name] = encryptionService.decrypt(s.valueEncrypted);
              } catch {
                // skip
              }
            }

            const filePayload = snapshot.map((f) => ({ path: f.path, content: f.content }));
            const result = await deployProductionContainer(
              projectId,
              currentProject.prodContainerId,
              filePayload,
              envVars,
            );

            if (result) {
              await db
                .update(projectsTable)
                .set({
                  prodContainerId: result.prodContainerId,
                  prodContainerUrl: result.containerUrl,
                  prodContainerStatus: result.status,
                })
                .where(eq(projectsTable.id, projectId));
              logger.info(
                { projectId, prodContainerId: result.prodContainerId },
                "Prod container redeployed after rollback",
              );
            }
          } catch (err) {
            logger.error({ err, projectId }, "Prod container rollback redeploy failed — non-fatal");
          }
        })();
      });
    }

    // Optional: restore a linked database snapshot along with the files
    let dbSnapshotRestored = false;
    let dbSnapshotId: number | null = null;
    let dbSnapshotError: string | null = null;

    if (restoreDb) {
      try {
        // Find the most recent snapshot linked to this version
        const [linkedSnapshot] = await db
          .select()
          .from(dbSnapshotsTable)
          .where(
            and(
              eq(dbSnapshotsTable.projectId, projectId),
              eq(dbSnapshotsTable.versionId, versionId),
            ),
          )
          .orderBy(desc(dbSnapshotsTable.createdAt))
          .limit(1);

        if (!linkedSnapshot) {
          dbSnapshotError = "No database snapshot is linked to this version.";
        } else {
          // Resolve dump content: prefer GCS object, fall back to inline column
          const dumpContent =
            (await downloadSnapshotBlob(linkedSnapshot.objectKey)) ?? linkedSnapshot.dumpContent;

          if (!dumpContent) {
            dbSnapshotError = "Snapshot content is missing from storage and cannot be restored.";
            logger.error({ projectId, versionId }, "Rollback: DB snapshot content missing");
          } else if (linkedSnapshot.provider === "postgres") {
            // Get DATABASE_URL secret and run deterministic DROP+CREATE+INSERT restore
            const [secretRow] = await db
              .select()
              .from(secretsTable)
              .where(
                and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, "DATABASE_URL")),
              );

            if (!secretRow) {
              dbSnapshotError =
                "DATABASE_URL secret not found. Add the secret in the Secrets tab and retry.";
            } else {
              const connectionString = encryptionService.decrypt(secretRow.valueEncrypted);
              if (!connectionString || connectionString.includes("localhost:5432")) {
                dbSnapshotError =
                  "DATABASE_URL is a placeholder. Replace it with a real connection string.";
              } else {
                const { statementsRun, errors } = await restorePostgresDump(
                  connectionString,
                  dumpContent,
                );
                logger.info(
                  { projectId, versionId, statementsRun, errors },
                  "Rollback: Postgres snapshot restored",
                );
                dbSnapshotRestored = true;
                dbSnapshotId = linkedSnapshot.id;
              }
            }
          } else if (linkedSnapshot.provider === "sqlite") {
            // Load container ID for the project and restore SQLite snapshot
            const [proj] = await db
              .select({
                containerId: projectsTable.containerId,
                containerStatus: projectsTable.containerStatus,
              })
              .from(projectsTable)
              .where(eq(projectsTable.id, projectId));

            if (!proj?.containerId || proj.containerStatus !== "running") {
              dbSnapshotError =
                "SQLite restore requires an active container. Start the container and retry.";
              logger.warn(
                { projectId, versionId },
                "Rollback: SQLite snapshot skipped — container not running",
              );
            } else {
              const { statementsRun, errors } = await restoreSQLiteSnapshot(
                proj.containerId,
                dumpContent,
                projectId,
              );
              logger.info(
                { projectId, versionId, statementsRun, errors },
                "Rollback: SQLite snapshot restored",
              );
              dbSnapshotRestored = true;
              dbSnapshotId = linkedSnapshot.id;
            }
          } else {
            dbSnapshotError = `Unsupported snapshot provider: ${linkedSnapshot.provider}`;
          }

          if (dbSnapshotRestored) {
            await emitRollbackEvent(
              taskId,
              "db_snapshot_restored",
              `Database snapshot "${linkedSnapshot.label}" restored.`,
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        dbSnapshotError = `Database restore failed: ${message}`;
        logger.error({ err, projectId, versionId }, "DB snapshot restore failed");
      }
    }

    res.json({
      restoredFiles: snapshot.length,
      versionId,
      label: version.label,
      taskId: rollbackTask?.id ?? null,
      dbSnapshotRestored,
      dbSnapshotId,
      dbSnapshotError,
    });
  },
);

// ── POST /api/projects/:id/versions/:versionId/approve-testing ───────────────
// Mark a version as approved for production promotion (Task #767 testing gate).
// Only the project owner or org admin/owner role may approve.
// Approval is idempotent — re-approving an already-approved version is a no-op.
router.post(
  "/projects/:id/versions/:versionId/approve-testing",
  requireProjectAccess("admin"),
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const versionId = Number(req.params.versionId);

    if (!Number.isFinite(projectId) || !Number.isFinite(versionId)) {
      res.status(400).json({ error: "Invalid project or version ID" });
      return;
    }

    const [version] = await db
      .select({
        id: projectVersionsTable.id,
        projectId: projectVersionsTable.projectId,
        testingApprovedAt: projectVersionsTable.testingApprovedAt,
      })
      .from(projectVersionsTable)
      .where(
        and(eq(projectVersionsTable.id, versionId), eq(projectVersionsTable.projectId, projectId)),
      );

    if (!version) {
      res.status(404).json({ error: "Version not found" });
      return;
    }

    // Idempotent: if already approved, return current state.
    if (version.testingApprovedAt) {
      res.json({
        ok: true,
        versionId,
        testingApprovedAt: version.testingApprovedAt,
        testingApprovedBy: req.userId,
        alreadyApproved: true,
      });
      return;
    }

    // ── Preconditions ─────────────────────────────────────────────────────────
    // Load project state for pre-conditions.
    const [project] = await db
      .select({
        testingStatus: projectsTable.testingStatus,
        testingCandidateSnapshotId: projectsTable.testingCandidateSnapshotId,
        testContainerStatus: projectsTable.testContainerStatus,
        runningTestSnapshotId: projectsTable.runningTestSnapshotId,
        containerId: projectsTable.containerId,
        builderMode: projectsTable.builderMode,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    // Preconditions below apply only to full-stack projects that have a real
    // test container. Static/web projects (containerId=null) have no container
    // to start, so testingStatus stays 'idle' forever — skip these checks and
    // allow direct approval.
    if (project.containerId) {
      // Precondition: this version must be the active testing candidate.
      if (
        project.testingCandidateSnapshotId !== null &&
        project.testingCandidateSnapshotId !== versionId
      ) {
        res.status(422).json({
          error: `Version ${versionId} is not the active testing candidate (candidate is version ${project.testingCandidateSnapshotId}). Use POST /preview-env/approve to approve the current candidate.`,
          code: "not_active_candidate",
          activeCandidate: project.testingCandidateSnapshotId,
        });
        return;
      }

      // Precondition: testing status must indicate the environment was ready.
      if (project.testingStatus === "stale" || project.testingStatus === "idle") {
        res.status(422).json({
          error: `Testing status is '${project.testingStatus}'. The test environment must be started and ready before approving.`,
          code: "testing_not_ready",
          testingStatus: project.testingStatus,
        });
        return;
      }
    }

    // Precondition: migration status must not be failed.
    const [versionDetails] = await db
      .select({ migrationStatus: projectVersionsTable.migrationStatus })
      .from(projectVersionsTable)
      .where(eq(projectVersionsTable.id, versionId));
    if (versionDetails?.migrationStatus === "failed") {
      res.status(422).json({
        error:
          "Preview database migration failed for this version. Fix migrations before approving.",
        code: "migration_failed",
      });
      return;
    }

    const now = new Date();
    await db
      .update(projectVersionsTable)
      .set({ testingApprovedAt: now, testingApprovedBy: req.userId ?? null })
      .where(eq(projectVersionsTable.id, versionId));

    // Also update the project's testedSnapshotId and testingStatus.
    await db
      .update(projectsTable)
      .set({
        testedSnapshotId: versionId,
        testingStatus: "passed",
        updatedAt: new Date(),
      })
      .where(eq(projectsTable.id, projectId));

    res.json({
      ok: true,
      versionId,
      testingApprovedAt: now,
      testingApprovedBy: req.userId,
      alreadyApproved: false,
    });
  },
);

export default router;
