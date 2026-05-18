import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, projectsTable, projectFilesTable, projectVersionsTable, deploymentLogsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { writeKnowledge } from "../lib/knowledge";

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

// POST /api/projects/:id/duplicate — copies a project (files included, secrets excluded)
router.post(
  "/projects/:id/duplicate",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);

    const [original] = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));
    if (!original) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const files = await db
      .select()
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId));

    const [newProject] = await db
      .insert(projectsTable)
      .values({
        name: `${original.name} (copy)`,
        kind: original.kind,
        description: original.description,
        ownerId: req.userId!,
        status: "draft",
        agentMode: original.agentMode,
        lastTaskSummary: `Duplicated from "${original.name}"`,
      })
      .returning();

    if (!newProject) {
      res.status(500).json({ error: "Failed to create duplicate project" });
      return;
    }

    if (files.length > 0) {
      await db.insert(projectFilesTable).values(
        files.map((f) => ({
          projectId: newProject.id,
          path: f.path,
          content: f.content,
          mimeType: f.mimeType,
        })),
      );
    }

    await db
      .update(projectsTable)
      .set({ updatedAt: sql`now()` })
      .where(eq(projectsTable.id, newProject.id));

    void writeKnowledge({
      title: `Project duplicated: "${original.name}" → "${newProject.name}"`,
      content: `User duplicated project "${original.name}" (id:${projectId}) into new project id:${newProject.id}. ${files.length} file(s) copied. Secrets were NOT copied.`,
      type: "duplicate",
      category: "event",
      severity: "info",
      projectId: newProject.id,
      userId: req.userId,
    });

    res.status(201).json({
      id: newProject.id,
      name: newProject.name,
      kind: newProject.kind,
      status: newProject.status,
      ownerId: newProject.ownerId,
      filesCount: files.length,
      secretsCopied: false,
      note: "Secrets are not copied for security. Add them in the Tools tab.",
    });
  },
);

// POST /api/projects/:id/publish — snapshots files as a deployment record,
// sets publishedSnapshotId, marks status=published.
// Public URL: /api/p/:publicSlug/ — slug-based, does not expose project ID.
// Slug is generated on first publish and preserved on republish.
// Draft changes after publish are NOT visible until the user publishes again.
router.post(
  "/projects/:id/publish",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);

    const [project] = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));
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
    const deploymentLabel = `Published — ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`;

    // Snapshot the files into a version record (this is the frozen public copy)
    const [deploymentVersion] = await db
      .insert(projectVersionsTable)
      .values({
        projectId,
        label: deploymentLabel,
        note: `Deployment snapshot. ${files.length} file(s). Actor: ${req.userId ?? "unknown"}. Published: ${publishedAt}`,
        filesSnapshot: files.map((f) => ({
          path: f.path,
          content: f.content,
          mimeType: f.mimeType,
        })),
      })
      .returning({ id: projectVersionsTable.id, label: projectVersionsTable.label });

    // Mark the project published, store which snapshot is live, and save the slug.
    await db
      .update(projectsTable)
      .set({
        status: "published",
        publishedSnapshotId: deploymentVersion?.id ?? null,
        publicSlug: slug,
        updatedAt: sql`now()`,
      })
      .where(eq(projectsTable.id, projectId));

    const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
    const protocol = (req.headers["x-forwarded-proto"] as string) ?? "http";
    const publicUrl = `${protocol}://${host}/api/p/${slug}/`;

    void writeKnowledge({
      title: `Published: project ${projectId}`,
      content: `Project id:${projectId} published by ${req.userId ?? "unknown"}. Slug: ${slug}. Snapshot version id:${deploymentVersion?.id}. ${files.length} file(s) frozen. Public URL: ${publicUrl}`,
      type: "publish",
      category: "event",
      severity: "info",
      projectId,
      userId: req.userId,
      relatedVersionId: deploymentVersion?.id,
    });

    setImmediate(() => {
      void db.insert(deploymentLogsTable).values({
        projectId,
        userId: req.userId ?? "unknown",
        env: "production",
        status: "passed",
        publicSlug: slug,
        publicUrl,
        filesCount: files.length,
        snapshotVersionId: deploymentVersion?.id ?? null,
        note: "Published by user.",
      }).catch(() => { /* best-effort */ });
    });

    res.json({
      projectId,
      status: "published",
      publicSlug: slug,
      publicUrl,
      publishedAt,
      deploymentVersionId: deploymentVersion?.id,
      deploymentLabel: deploymentVersion?.label,
      filesSnapshotted: files.length,
      note: "Public URL serves the frozen snapshot. Draft edits do not affect it until you publish again.",
    });
  },
);

// POST /api/projects/:id/unpublish — clears the published snapshot, reverts to testing.
// The publicSlug is intentionally preserved so republishing reuses the same public URL.
router.post(
  "/projects/:id/unpublish",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);

    await db
      .update(projectsTable)
      .set({ status: "testing", publishedSnapshotId: null, updatedAt: sql`now()` })
      .where(eq(projectsTable.id, projectId));

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
      void db.insert(deploymentLogsTable).values({
        projectId,
        userId: req.userId ?? "unknown",
        env: "production",
        status: "unpublished",
        note: "Unpublished by user.",
      }).catch(() => { /* best-effort */ });
    });

    res.json({ projectId, status: "testing", publicUrl: null });
  },
);

export default router;
