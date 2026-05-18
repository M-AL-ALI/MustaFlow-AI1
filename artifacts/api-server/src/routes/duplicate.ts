import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, projectsTable, projectFilesTable, projectVersionsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { writeKnowledge } from "../lib/knowledge";

const router: IRouter = Router();

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
// The public URL is /api/p/:projectId/ — served from the snapshot (not live files).
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

    // Mark the project published and store which snapshot is live
    await db
      .update(projectsTable)
      .set({
        status: "published",
        publishedSnapshotId: deploymentVersion?.id ?? null,
        updatedAt: sql`now()`,
      })
      .where(eq(projectsTable.id, projectId));

    const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
    const protocol = (req.headers["x-forwarded-proto"] as string) ?? "http";
    // Public URL uses the /p/ route — served from snapshot, no auth required
    const publicUrl = `${protocol}://${host}/api/p/${projectId}/`;

    void writeKnowledge({
      title: `Published: project ${projectId}`,
      content: `Project id:${projectId} published by ${req.userId ?? "unknown"}. Snapshot version id:${deploymentVersion?.id}. ${files.length} file(s) frozen. Public URL: ${publicUrl}`,
      type: "publish",
      category: "event",
      severity: "info",
      projectId,
      userId: req.userId,
      relatedVersionId: deploymentVersion?.id,
    });

    res.json({
      projectId,
      status: "published",
      publicUrl,
      publishedAt,
      deploymentVersionId: deploymentVersion?.id,
      deploymentLabel: deploymentVersion?.label,
      filesSnapshotted: files.length,
      note: "Public URL serves the frozen snapshot. Draft edits do not affect it until you publish again.",
    });
  },
);

// POST /api/projects/:id/unpublish — clears the published snapshot, reverts to testing
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
      content: `Project id:${projectId} unpublished by ${req.userId ?? "unknown"}. Public URL is now inactive.`,
      type: "publish",
      category: "event",
      severity: "info",
      projectId,
      userId: req.userId,
    });

    res.json({ projectId, status: "testing", publicUrl: null });
  },
);

export default router;
