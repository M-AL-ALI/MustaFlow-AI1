import { Router, type IRouter } from "express";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import {
  db,
  projectsTable,
  chatMessagesTable,
  agentTasksTable,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
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

// Active projects only — soft-deleted rows are excluded from all user-facing queries.
const activeProjects = isNull(projectsTable.deletedAt);

router.get("/projects", async (req, res): Promise<void> => {
  const userId = req.userId ?? "demo-user";
  const wsId = req.query.workspaceId ? parseInt(req.query.workspaceId as string, 10) : null;
  const conditions: SQL[] = [eq(projectsTable.ownerId, userId), activeProjects];
  if (wsId && !isNaN(wsId)) conditions.push(eq(projectsTable.workspaceId, wsId));
  const rows = await db
    .select()
    .from(projectsTable)
    .where(and(...conditions))
    .orderBy(desc(projectsTable.updatedAt));
  res.json(ListProjectsResponse.parse(rows));
});

router.get("/projects/summary", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.ownerId, req.userId ?? "demo-user"), activeProjects));

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

  // Derive platform from kind
  const platformMap: Record<string, string> = {
    "mobile-ios": "ios",
    "mobile-android": "android",
    "mobile-cross": "cross",
  };
  const platform = platformMap[projectInput.kind] ?? "web";

  const [project] = await db
    .insert(projectsTable)
    .values({
      ownerId: req.userId ?? "demo-user",
      workspaceId: projectInput.workspaceId ?? null,
      name: projectInput.name,
      description: projectInput.description ?? null,
      kind: projectInput.kind,
      platform,
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

router.get("/projects/:id", requireProjectOwnership, async (req, res): Promise<void> => {
  const params = GetProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.id), activeProjects));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json(GetProjectResponse.parse(project));
});

router.patch("/projects/:id", requireProjectOwnership, async (req, res): Promise<void> => {
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
    .where(and(eq(projectsTable.id, params.data.id), activeProjects))
    .returning();

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json(UpdateProjectResponse.parse(project));
});

// Soft delete — sets deletedAt instead of removing the row.
// All project-scoped data (files, secrets, versions, etc.) is retained for
// potential recovery but the project disappears from all user-facing queries.
router.delete("/projects/:id", requireProjectOwnership, async (req, res): Promise<void> => {
  const params = DeleteProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db
    .update(projectsTable)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(projectsTable.id, params.data.id), activeProjects))
    .returning();

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.status(200).json({ deleted: true, projectId: project.id });
});

// Used by activity feed - keep references so unused-import linter doesn't trip
void agentTasksTable;

export default router;
