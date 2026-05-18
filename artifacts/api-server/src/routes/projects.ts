import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import {
  db,
  projectsTable,
  chatMessagesTable,
  agentTasksTable,
} from "@workspace/db";
import {
  CreateProjectBody,
  GetProjectParams,
  GetProjectResponse,
  ListProjectsResponse,
  UpdateProjectBody,
  UpdateProjectParams,
  UpdateProjectResponse,
  DeleteProjectParams,
  GetProjectsSummaryResponse,
} from "@workspace/api-zod";
import { buildInitialAssistantMessage } from "../lib/ai";

const router: IRouter = Router();

router.get("/projects", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(projectsTable)
    .orderBy(desc(projectsTable.updatedAt));
  res.json(ListProjectsResponse.parse(rows));
});

router.get("/projects/summary", async (_req, res): Promise<void> => {
  const rows = await db.select().from(projectsTable);

  const byStatus: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  }

  const recent = [...rows]
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
    .slice(0, 6);

  res.json(
    GetProjectsSummaryResponse.parse({
      total: rows.length,
      byStatus,
      byKind,
      recent,
    }),
  );
});

router.post("/projects", async (req, res): Promise<void> => {
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { initialPrompt, ...projectInput } = parsed.data;

  const [project] = await db
    .insert(projectsTable)
    .values({
      name: projectInput.name,
      description: projectInput.description ?? null,
      kind: projectInput.kind,
      lastTaskSummary: initialPrompt
        ? `Initial idea: ${initialPrompt.slice(0, 120)}`
        : null,
    })
    .returning();

  if (!project) {
    res.status(500).json({ error: "Failed to create project" });
    return;
  }

  if (initialPrompt && initialPrompt.trim().length > 0) {
    await db.insert(chatMessagesTable).values({
      projectId: project.id,
      role: "user",
      content: initialPrompt,
      agentMode: "eco",
      planMode: false,
    });

    const greeting = buildInitialAssistantMessage(project.name, initialPrompt);
    await db.insert(chatMessagesTable).values({
      projectId: project.id,
      role: "assistant",
      content: greeting,
      agentMode: "eco",
      planMode: false,
    });
  }

  res.status(201).json(GetProjectResponse.parse(project));
});

router.get("/projects/:id", async (req, res): Promise<void> => {
  const params = GetProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
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

  res.json(GetProjectResponse.parse(project));
});

router.patch("/projects/:id", async (req, res): Promise<void> => {
  const params = UpdateProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [project] = await db
    .update(projectsTable)
    .set({ ...parsed.data, updatedAt: sql`now()` })
    .where(eq(projectsTable.id, params.data.id))
    .returning();

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json(UpdateProjectResponse.parse(project));
});

router.delete("/projects/:id", async (req, res): Promise<void> => {
  const params = DeleteProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db
    .delete(projectsTable)
    .where(eq(projectsTable.id, params.data.id))
    .returning();

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.sendStatus(204);
});

// Used by activity feed - keep references so unused-import linter doesn't trip
void agentTasksTable;

export default router;
