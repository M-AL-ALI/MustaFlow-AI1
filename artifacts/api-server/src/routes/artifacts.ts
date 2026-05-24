import { Router, type IRouter } from "express";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, projectArtifactsTable, projectFilesTable, type ProjectArtifact } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Multi-artifact projects (Task #544).
 *
 * A project owns ≥1 artifacts. The legacy single-artifact contract is preserved
 * by always backing every project with one is_primary=true row whose
 * kind/stack/platform/projectFormat mirror the parent projects.* columns.
 *
 * The shipped surface is intentionally minimal:
 *   GET    /projects/:id/artifacts         — list active artifacts
 *   POST   /projects/:id/artifacts         — add a new artifact (kind/name/platform)
 *   PATCH  /projects/:id/artifacts/:aid    — rename
 *   DELETE /projects/:id/artifacts/:aid    — soft-delete (cannot delete the primary)
 *
 * Per-artifact preview/publish/container routing is deferred to a follow-up;
 * for now the primary artifact remains the de-facto target for those flows.
 */

const SLUG_BASE_BY_KIND: Record<string, string> = {
  web: "web",
  "mobile-cross": "mobile",
  "mobile-ios": "ios",
  "mobile-android": "android",
  api: "api",
  slides: "slides",
  "data-app": "data",
};

const FORMAT_BY_KIND: Record<string, { platform: string; projectFormat: string; stack: string }> = {
  web: { platform: "web", projectFormat: "react-vite", stack: "react-vite" },
  "mobile-cross": { platform: "cross", projectFormat: "static-html", stack: "react-vite" },
  "mobile-ios": { platform: "ios", projectFormat: "static-html", stack: "react-vite" },
  "mobile-android": { platform: "android", projectFormat: "static-html", stack: "react-vite" },
  api: { platform: "server", projectFormat: "node-api", stack: "node-api" },
  slides: { platform: "web", projectFormat: "slides", stack: "react-vite" },
  "data-app": { platform: "web", projectFormat: "data-app", stack: "react-vite" },
};

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "artifact"
  );
}

async function uniqueSlug(projectId: number, base: string): Promise<string> {
  const existing = await db
    .select({ slug: projectArtifactsTable.slug })
    .from(projectArtifactsTable)
    .where(eq(projectArtifactsTable.projectId, projectId));
  const used = new Set(existing.map((r) => r.slug));
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function serialize(a: ProjectArtifact) {
  return {
    id: a.id,
    projectId: a.projectId,
    kind: a.kind,
    platform: a.platform,
    projectFormat: a.projectFormat,
    stack: a.stack,
    name: a.name,
    slug: a.slug,
    isPrimary: a.isPrimary,
    status: a.status,
    lastTaskSummary: a.lastTaskSummary,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

router.get("/projects/:id/artifacts", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const rows = await db
    .select()
    .from(projectArtifactsTable)
    .where(
      and(eq(projectArtifactsTable.projectId, projectId), isNull(projectArtifactsTable.deletedAt)),
    )
    .orderBy(asc(projectArtifactsTable.createdAt));
  res.json(rows.map(serialize));
});

router.post("/projects/:id/artifacts", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const body = (req.body ?? {}) as { kind?: unknown; name?: unknown };
  const kind = typeof body.kind === "string" ? body.kind : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!FORMAT_BY_KIND[kind]) {
    res.status(400).json({
      error: `Unsupported kind. Use one of: ${Object.keys(FORMAT_BY_KIND).join(", ")}`,
    });
    return;
  }
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const format = FORMAT_BY_KIND[kind]!;
  const base = SLUG_BASE_BY_KIND[kind] ?? slugify(name);
  const slug = await uniqueSlug(projectId, base);

  const [created] = await db
    .insert(projectArtifactsTable)
    .values({
      projectId,
      kind,
      platform: format.platform,
      projectFormat: format.projectFormat,
      stack: format.stack,
      name,
      slug,
      isPrimary: false,
      status: "draft",
    })
    .returning();

  if (!created) {
    res.status(500).json({ error: "Failed to create artifact" });
    return;
  }

  logger.info({ projectId, artifactId: created.id, kind, slug }, "artifact created");
  res.status(201).json(serialize(created));
});

router.patch(
  "/projects/:id/artifacts/:aid",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const aid = Number(req.params.aid);
    if (!Number.isFinite(aid)) {
      res.status(400).json({ error: "Invalid artifact id" });
      return;
    }
    const body = (req.body ?? {}) as { name?: unknown; status?: unknown };
    const updates: Partial<ProjectArtifact> = {};
    if (typeof body.name === "string" && body.name.trim()) updates.name = body.name.trim();
    if (typeof body.status === "string") updates.status = body.status;
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "no updatable fields supplied" });
      return;
    }
    const [updated] = await db
      .update(projectArtifactsTable)
      .set({ ...updates, updatedAt: new Date() })
      .where(and(eq(projectArtifactsTable.id, aid), eq(projectArtifactsTable.projectId, projectId)))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
    res.json(serialize(updated));
  },
);

router.delete(
  "/projects/:id/artifacts/:aid",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const aid = Number(req.params.aid);
    if (!Number.isFinite(aid)) {
      res.status(400).json({ error: "Invalid artifact id" });
      return;
    }
    const [existing] = await db
      .select()
      .from(projectArtifactsTable)
      .where(
        and(eq(projectArtifactsTable.id, aid), eq(projectArtifactsTable.projectId, projectId)),
      );
    if (!existing) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
    if (existing.isPrimary) {
      res.status(400).json({
        error:
          "Cannot delete the primary artifact. Promote another artifact to primary first (not yet supported).",
      });
      return;
    }
    await db
      .update(projectArtifactsTable)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(projectArtifactsTable.id, aid));
    // Also cascade-delete the files for this artifact so re-creation with the
    // same slug doesn't collide on the (project_id, path) unique index.
    await db.delete(projectFilesTable).where(eq(projectFilesTable.artifactId, aid));
    res.json({ deleted: true });
  },
);

export default router;
