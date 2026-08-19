import { Router, type IRouter } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, projectsTable, projectFilesTable, projectActivityTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { writeKnowledge } from "../lib/knowledge";
import { enqueueProvisionProjectJob } from "../lib/provisioning";
import {
  ProjectWorkspaceUnavailableError,
  resolveProjectWorkspaceId,
} from "../lib/workspace-tenancy";
import { projectSummaryProvenance } from "../lib/project-summary-provenance";

const router: IRouter = Router();

// POST /api/projects/:id/duplicate — copies a project (files included, secrets excluded)
router.post("/projects/:id/duplicate", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);

  const [original] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
  if (!original) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const files = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));

  let workspaceId: number;
  try {
    workspaceId = await resolveProjectWorkspaceId({
      userId: req.userId!,
      requestedWorkspaceId: original.workspaceId,
    });
  } catch (error) {
    if (error instanceof ProjectWorkspaceUnavailableError) {
      res.status(409).json({ error: error.code });
      return;
    }
    throw error;
  }

  const [newProject] = await db
    .insert(projectsTable)
    .values({
      name: `${original.name} (copy)`,
      kind: original.kind,
      description: original.description,
      ownerId: req.userId!,
      workspaceId,
      status: "draft",
      agentMode: original.agentMode,
      lastTaskSummary: `Duplicated from "${original.name}"`,
      lastTaskSummaryProvenance: projectSummaryProvenance({
        sourceKind: "duplicate",
        sourceIdentity: `project:${original.id}`,
        sourceProjectId: original.id,
        actorUserId: req.userId,
        content: `Duplicated from "${original.name}"`,
      }),
      // Task #738 — duplicated projects are brand-new infra and must get
      // their own container + Neon DB, not reuse the source project's.
      builderMode: "agentic",
      provisioningStatus: "provisioning",
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

  enqueueProvisionProjectJob(newProject.id);

  // Log activity on source project and new project (best-effort)
  try {
    await db.insert(projectActivityTable).values({
      projectId,
      actorId: req.userId ?? null,
      actorName: null,
      eventType: "duplicate",
      summary: `Project duplicated to "${newProject.name}"`,
      metadata: { targetProjectId: newProject.id, targetName: newProject.name },
    });
  } catch {
    // non-fatal
  }
  try {
    await db.insert(projectActivityTable).values({
      projectId: newProject.id,
      actorId: req.userId ?? null,
      actorName: null,
      eventType: "cloned_from",
      summary: `Cloned from "${original.name}"`,
      metadata: { sourceProjectId: projectId, sourceName: original.name },
    });
  } catch {
    // non-fatal
  }

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
});

export default router;
