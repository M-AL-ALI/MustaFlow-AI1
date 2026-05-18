import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, projectsTable, projectFilesTable, projectVersionsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";

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

    // Create the duplicate project
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

    // Copy files
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

// POST /api/projects/:id/publish — marks project as publicly accessible and
// saves a deployment version record so there is an auditable snapshot of
// exactly what was live at publish time.
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

    // Snapshot current files into a deployment version record
    const files = await db
      .select()
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId));

    const publishedAt = new Date().toISOString();
    const deploymentLabel = `Published — ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`;

    const [deploymentVersion] = await db
      .insert(projectVersionsTable)
      .values({
        projectId,
        label: deploymentLabel,
        note: `Deployment snapshot. Files: ${files.length}. Actor: ${req.userId ?? "unknown"}. Published at: ${publishedAt}`,
        filesSnapshot: files.map((f) => ({
          path: f.path,
          content: f.content,
          mimeType: f.mimeType,
        })),
      })
      .returning({ id: projectVersionsTable.id, label: projectVersionsTable.label });

    // Mark the project as published
    await db
      .update(projectsTable)
      .set({ status: "published", updatedAt: sql`now()` })
      .where(eq(projectsTable.id, projectId));

    const host =
      req.headers["x-forwarded-host"] ??
      req.headers.host ??
      "localhost";
    const protocol =
      (req.headers["x-forwarded-proto"] as string) ?? "http";
    const publicUrl = `${protocol}://${host}/api/projects/${projectId}/preview/`;

    res.json({
      projectId,
      status: "published",
      publicUrl,
      publishedAt,
      deploymentVersionId: deploymentVersion?.id,
      deploymentLabel: deploymentVersion?.label,
      filesSnapshotted: files.length,
      note: "Project files are now publicly accessible via publicUrl without authentication.",
    });
  },
);

// POST /api/projects/:id/unpublish — reverts project to testing status
router.post(
  "/projects/:id/unpublish",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);

    await db
      .update(projectsTable)
      .set({ status: "testing", updatedAt: sql`now()` })
      .where(eq(projectsTable.id, projectId));

    res.json({ projectId, status: "testing" });
  },
);

export default router;
