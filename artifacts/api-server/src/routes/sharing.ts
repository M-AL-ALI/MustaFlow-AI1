import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, shareLinksTable, projectFilesTable, projectVersionsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { z } from "zod";
import { randomBytes } from "crypto";

// Express v5 types params as string | string[] — extract the scalar value.
const pstr = (v: string | string[]): string => (Array.isArray(v) ? (v[0] ?? "") : v);

const router: IRouter = Router();

// ── Public share link viewer (no auth required) ───────────────────────────────
// Exported separately so it can be mounted BEFORE the auth wall.
export const publicShareRouter: IRouter = Router();

// ── Create share link ─────────────────────────────────────────────────────────
const CreateShareLinkBody = z.object({
  label: z.string().max(200).optional(),
  scope: z.enum(["draft", "snapshot"]).default("draft"),
  snapshotVersionId: z.number().int().positive().optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

router.post("/projects/:id/share", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = parseInt(pstr(req.params.id), 10);
  const userId = req.userId!;

  const parsed = CreateShareLinkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = parsed.data.expiresInDays
    ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  const [link] = await db
    .insert(shareLinksTable)
    .values({
      projectId,
      token,
      label: parsed.data.label ?? null,
      createdByUserId: userId,
      scope: parsed.data.scope,
      snapshotVersionId: parsed.data.snapshotVersionId ?? null,
      expiresAt,
    })
    .returning();

  if (!link) {
    res.status(500).json({ error: "Failed to create share link" });
    return;
  }
  res.status(201).json(link);
});

// ── List share links for a project ───────────────────────────────────────────
router.get("/projects/:id/share", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = parseInt(pstr(req.params.id), 10);

  const links = await db
    .select()
    .from(shareLinksTable)
    .where(and(eq(shareLinksTable.projectId, projectId)))
    .orderBy(desc(shareLinksTable.createdAt));

  res.json(links);
});

// ── Revoke share link ─────────────────────────────────────────────────────────
router.delete(
  "/projects/:id/share/:linkId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = parseInt(pstr(req.params.id), 10);
    const linkId = parseInt(pstr(req.params.linkId), 10);

    if (!Number.isFinite(linkId)) {
      res.status(400).json({ error: "Invalid link id" });
      return;
    }

    const [link] = await db
      .select()
      .from(shareLinksTable)
      .where(and(eq(shareLinksTable.id, linkId), eq(shareLinksTable.projectId, projectId)));

    if (!link) {
      res.status(404).json({ error: "Share link not found" });
      return;
    }

    await db
      .update(shareLinksTable)
      .set({ revoked: true, revokedAt: new Date() })
      .where(eq(shareLinksTable.id, linkId));

    res.json({ revoked: true });
  },
);

// ── Public share link viewer (no auth required) — mounted on publicShareRouter ─
publicShareRouter.get("/share/:token", async (req, res): Promise<void> => {
  const { token } = req.params;
  const [link] = await db.select().from(shareLinksTable).where(eq(shareLinksTable.token, token));

  if (!link) {
    res.status(404).json({ error: "Share link not found" });
    return;
  }
  if (link.revoked) {
    res.status(410).json({ error: "This share link has been revoked" });
    return;
  }
  if (link.expiresAt && link.expiresAt < new Date()) {
    res.status(410).json({ error: "This share link has expired" });
    return;
  }

  // Bump view count (best-effort, non-fatal)
  db.update(shareLinksTable)
    .set({ viewCount: link.viewCount + 1, lastViewedAt: new Date() })
    .where(eq(shareLinksTable.id, link.id))
    .catch(() => {});

  // For snapshot scope, return files from the frozen snapshot
  if (link.scope === "snapshot" && link.snapshotVersionId != null) {
    const [version] = await db
      .select({ filesSnapshot: projectVersionsTable.filesSnapshot })
      .from(projectVersionsTable)
      .where(eq(projectVersionsTable.id, link.snapshotVersionId));
    const files = (version?.filesSnapshot as { path: string; mimeType: string }[] | null) ?? [];
    res.json({
      projectId: link.projectId,
      scope: link.scope,
      label: link.label,
      files: files.map((f) => ({ path: f.path, mimeType: f.mimeType })),
    });
    return;
  }

  // Draft scope — return live file list
  const files = await db
    .select({ path: projectFilesTable.path, mimeType: projectFilesTable.mimeType })
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, link.projectId));

  res.json({
    projectId: link.projectId,
    scope: link.scope,
    label: link.label,
    files,
  });
});

export default router;
