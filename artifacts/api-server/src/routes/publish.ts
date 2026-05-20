// ─────────────────────────────────────────────────────────────────────────────
// Publish routes
//
//   POST /api/projects/:id/publish   — freeze snapshot, set publicSlug, go live
//   POST /api/projects/:id/unpublish — clear snapshot, disable public URL
//
// Publish generates a publicSlug on first publish and preserves it on republish.
// The public route /api/p/:slug/ always serves from the frozen snapshot, not live files.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { eq, sql, isNull, and } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectFilesTable,
  projectVersionsTable,
  deploymentLogsTable,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { writeKnowledge } from "../lib/knowledge";
import { generateOgSvg } from "../lib/ogImage";

const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";

const router: IRouter = Router();

// Generates a URL-safe slug from a project name + random suffix.
// Format: <slugified-name>-<6-random-chars>
// Does NOT expose the project's integer ID.
function generatePublicSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const rand = Math.random().toString(36).slice(2, 8);
  return base ? `${base}-${rand}` : rand;
}

// ── POST /api/projects/:id/publish ───────────────────────────────────────────
router.post("/projects/:id/publish", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);

  // requireProjectOwnership already checks deletedAt — this is defense-in-depth.
  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const files = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));

  if (files.length === 0) {
    res.status(400).json({
      error: "Cannot publish a project with no generated files. Build the app first.",
    });
    return;
  }

  // Generate slug on first publish; preserve existing slug on republish.
  const slug: string = project.publicSlug ?? generatePublicSlug(project.name);

  const publishedAt = new Date().toISOString();
  const isRepublish = project.publicSlug !== null;
  const deploymentLabel = `${isRepublish ? "Republished" : "Published"} — ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`;

  // Generate OG image at publish time and store as a base64 data URL so the
  // frozen snapshot always carries its own social preview card — no separate
  // on-demand route required.
  const ogSvg = generateOgSvg({
    name: project.name,
    description: project.description,
    themeColor: project.themeColor ?? null,
    kind: project.kind,
  });
  const ogImageUrl = `data:image/svg+xml;base64,${Buffer.from(ogSvg).toString("base64")}`;

  // Snapshot the files into a version record (this is the frozen public copy).
  const [deploymentVersion] = await db
    .insert(projectVersionsTable)
    .values({
      projectId,
      label: deploymentLabel,
      note: `Deployment snapshot. ${files.length} file(s). Actor: ${req.userId ?? "unknown"}. Published: ${publishedAt}`,
      ogImageUrl,
      filesSnapshot: files.map((f) => ({
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
      })),
    })
    .returning({ id: projectVersionsTable.id, label: projectVersionsTable.label });

  const publicUrl = `https://${slug}.${PLATFORM_DOMAIN}/`;
  const internalPathUrl = `/api/p/${slug}/`;

  // Mark the project published, store which snapshot is live, and save the slug.
  // Best-effort inside setImmediate so the response returns immediately.
  setImmediate(() => {
    void db
      .update(projectsTable)
      .set({
        status: "published",
        publishedSnapshotId: deploymentVersion?.id ?? null,
        publicSlug: slug,
        updatedAt: new Date(),
      })
      .catch(() => {
        /* best-effort */
      });
  });

  res.json({
    ok: true,
    projectId,
    status: "published",
    publicSlug: slug,
    publicUrl,
    internalPathUrl,
    publishedAt,
    snapshotVersionId: deploymentVersion?.id,
    filesPublished: files.length,
    note: "Public URL serves the frozen snapshot. Draft edits do not affect it until you publish again.",
  });
});

// ── POST /api/projects/:id/unpublish ─────────────────────────────────────────
router.post("/projects/:id/unpublish", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);

  // Fetch current slug so we can include it in the response (slug is never cleared).
  const [current] = await db
    .select({ publicSlug: projectsTable.publicSlug })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

  await db
    .update(projectsTable)
    .set({ status: "testing", publishedSnapshotId: null, updatedAt: sql`now()` })
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

  void writeKnowledge({
    title: `Unpublished: project ${projectId}`,
    content: `Project id:${projectId} unpublished by ${req.userId ?? "unknown"}. Public URL is now inactive. Slug preserved for next publish.`,
    type: "publish",
    category: "event",
    severity: "info",
    projectId,
    userId: req.userId,
  });

  setImmediate(() => {
    void db
      .insert(deploymentLogsTable)
      .values({
        projectId,
        userId: req.userId ?? "unknown",
        env: "production",
        status: "unpublished",
        note: "Unpublished by user. Public URL disabled.",
      })
      .catch(() => {
        /* best-effort */
      });
  });

  res.json({
    ok: true,
    projectId,
    status: "testing",
    publicSlug: current?.publicSlug ?? null,
    publicUrlDisabled: true,
  });
});

export default router;
