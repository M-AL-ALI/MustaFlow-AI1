// ─────────────────────────────────────────────────────────────────────────────
// Preview snapshots routes
//
//   GET  /api/projects/:id/preview-snapshots   — list per-build preview URLs
//   POST /api/projects/:id/preview-snapshots/:snapshotId/expire
//                                              — manually expire a preview URL
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, previewSnapshotsTable, projectVersionsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";

const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";

const router: IRouter = Router();

// ── GET /api/projects/:id/preview-snapshots ───────────────────────────────────
router.get(
  "/projects/:id/preview-snapshots",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);

    const rows = await db
      .select({
        id: previewSnapshotsTable.id,
        versionId: previewSnapshotsTable.versionId,
        taskId: previewSnapshotsTable.taskId,
        previewSlug: previewSnapshotsTable.previewSlug,
        expiresAt: previewSnapshotsTable.expiresAt,
        createdAt: previewSnapshotsTable.createdAt,
        versionLabel: projectVersionsTable.label,
      })
      .from(previewSnapshotsTable)
      .leftJoin(projectVersionsTable, eq(previewSnapshotsTable.versionId, projectVersionsTable.id))
      .where(eq(previewSnapshotsTable.projectId, projectId))
      .orderBy(desc(previewSnapshotsTable.createdAt))
      .limit(50);

    const now = new Date();

    res.json({
      previewSnapshots: rows.map((r) => ({
        id: r.id,
        versionId: r.versionId,
        taskId: r.taskId,
        previewSlug: r.previewSlug,
        previewUrl: `https://${r.previewSlug}.${PLATFORM_DOMAIN}/`,
        internalUrl: `/api/p/${r.previewSlug}/preview/`,
        expired: r.expiresAt ? new Date(r.expiresAt) < now : false,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
        versionLabel: r.versionLabel ?? null,
      })),
    });
  },
);

// ── POST /api/projects/:id/preview-snapshots/:snapshotId/expire ───────────────
router.post(
  "/projects/:id/preview-snapshots/:snapshotId/expire",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const snapshotId = Number(req.params.snapshotId);

    await db
      .update(previewSnapshotsTable)
      .set({ expiresAt: new Date() })
      .where(
        and(
          eq(previewSnapshotsTable.id, snapshotId),
          eq(previewSnapshotsTable.projectId, projectId),
        ),
      );

    res.json({ ok: true });
  },
);

export default router;
