import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, projectsTable, projectVersionsTable } from "@workspace/db";
import {
  ListVersionsParams,
  ListVersionsResponse,
  CreateVersionParams,
  CreateVersionBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/projects/:id/versions", async (req, res): Promise<void> => {
  const params = ListVersionsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(projectVersionsTable)
    .where(eq(projectVersionsTable.projectId, params.data.id))
    .orderBy(desc(projectVersionsTable.createdAt));
  res.json(ListVersionsResponse.parse(rows));
});

router.post("/projects/:id/versions", async (req, res): Promise<void> => {
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

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, params.data.id));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [v] = await db
    .insert(projectVersionsTable)
    .values({
      projectId: project.id,
      label: parsed.data.label,
      note: parsed.data.note ?? null,
    })
    .returning();

  res.status(201).json(v);
});

export default router;
