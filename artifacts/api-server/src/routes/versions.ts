import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectVersionsTable,
  projectFilesTable,
  chatMessagesTable,
} from "@workspace/db";
import {
  ListVersionsParams,
  ListVersionsResponse,
  CreateVersionParams,
  CreateVersionBody,
} from "@workspace/api-zod";
import { requireProjectOwnership } from "../lib/auth";

const router: IRouter = Router();

router.get(
  "/projects/:id/versions",
  requireProjectOwnership,
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
        createdAt: projectVersionsTable.createdAt,
      })
      .from(projectVersionsTable)
      .where(eq(projectVersionsTable.projectId, params.data.id))
      .orderBy(desc(projectVersionsTable.createdAt));
    res.json(ListVersionsResponse.parse(rows));
  },
);

router.post(
  "/projects/:id/versions",
  requireProjectOwnership,
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

router.post(
  "/projects/:id/versions/:versionId/rollback",
  requireProjectOwnership,
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
    const snapshot = version.filesSnapshot ?? [];

    await db
      .delete(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId));
    for (const f of snapshot) {
      await db.insert(projectFilesTable).values({
        projectId,
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
      });
    }

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
        lastTaskSummary: `Rolled back to "${version.label}"`,
      })
      .where(eq(projectsTable.id, projectId));

    res.json({
      restoredFiles: snapshot.length,
      versionId,
      label: version.label,
    });
  },
);

export default router;
