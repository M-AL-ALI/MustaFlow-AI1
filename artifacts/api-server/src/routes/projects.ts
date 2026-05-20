import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectFilesTable,
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

// ── Health score — content-based analysis ─────────────────────────────────────
// Computes a 0–100 score by inspecting the actual generated HTML files for a
// project. Four weighted dimensions (25 pts each):
//   Accessibility  — alt text, ARIA roles, semantic elements
//   SEO            — <title>, meta description, <h1>
//   Performance    — external script count, lazy loading
//   Security       — absence of eval(), document.write(), raw innerHTML concat
//
// Returns 0 for projects with no files yet.

interface FileRow {
  path: string;
  content: string;
  mimeType: string;
}

function scoreHtml(files: FileRow[]): number {
  const htmlFiles = files.filter(
    (f) => f.mimeType === "text/html" || f.path.endsWith(".html"),
  );
  if (htmlFiles.length === 0) {
    // Has non-HTML files — give partial credit for structure
    return files.length > 0 ? 20 : 0;
  }
  const html = htmlFiles.map((f) => f.content).join("\n");

  // Accessibility (0-25)
  let accessibility = 0;
  if (/<img[^>]+alt\s*=/.test(html))                             accessibility += 8;
  if (/aria-[a-z]+/.test(html))                                  accessibility += 9;
  if (/<(nav|main|header|footer|section|article)\b/.test(html)) accessibility += 8;

  // SEO (0-25)
  let seo = 0;
  if (/<title\b[^>]*>[^<]{2,}/.test(html))                            seo += 10;
  if (/meta[^>]+name\s*=\s*["']description["']/.test(html))           seo += 10;
  if (/<h1\b/.test(html))                                              seo +=  5;

  // Performance (0-25)
  const externalScripts = (html.match(/<script[^>]+src\s*=/g) ?? []).length;
  let performance = Math.max(0, 20 - externalScripts * 3);
  if (/loading\s*=\s*["']lazy["']/.test(html))                  performance +=  5;

  // Security (0-25) — deduct for dangerous patterns
  let security = 25;
  if (/\beval\s*\(/.test(html))                                  security -= 15;
  if (/document\.write\s*\(/.test(html))                         security -=  5;
  if (/innerHTML\s*=\s*[^"'`][^;]*\+/.test(html))               security -=  5;
  security = Math.max(0, security);

  return Math.min(100, accessibility + seo + performance + security);
}

async function computeHealthScoreForProject(projectId: number): Promise<number> {
  const files = await db
    .select({
      path: projectFilesTable.path,
      content: projectFilesTable.content,
      mimeType: projectFilesTable.mimeType,
    })
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));
  return scoreHtml(files);
}

async function computeHealthScoresBatch(
  projectIds: number[],
): Promise<Map<number, number>> {
  if (projectIds.length === 0) return new Map();
  const files = await db
    .select({
      projectId: projectFilesTable.projectId,
      path: projectFilesTable.path,
      content: projectFilesTable.content,
      mimeType: projectFilesTable.mimeType,
    })
    .from(projectFilesTable)
    .where(inArray(projectFilesTable.projectId, projectIds));

  const byProject = new Map<number, FileRow[]>();
  for (const f of files) {
    if (!byProject.has(f.projectId)) byProject.set(f.projectId, []);
    byProject.get(f.projectId)!.push(f);
  }

  const scores = new Map<number, number>();
  for (const id of projectIds) {
    scores.set(id, scoreHtml(byProject.get(id) ?? []));
  }
  return scores;
}

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
  const parsed = ListProjectsResponse.parse(rows);
  const scores = await computeHealthScoresBatch(rows.map((r) => r.id));
  const withScore = parsed.map((p) => ({
    ...p,
    healthScore: scores.get(p.id) ?? 0,
  }));
  res.json(withScore);
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

  const recentRows = [...rows]
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
    .slice(0, 6);

  const summaryParsed = GetProjectsSummaryResponse.parse({
    total: rows.length,
    byStatus,
    byKind,
    recent: recentRows,
  });

  const recentScores = await computeHealthScoresBatch(recentRows.map((r) => r.id));
  res.json({
    ...summaryParsed,
    recent: summaryParsed.recent.map((p) => ({
      ...p,
      healthScore: recentScores.get(p.id) ?? 0,
    })),
  });
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
      lastTaskSummary: initialPrompt ? `Initial idea: ${initialPrompt.slice(0, 120)}` : null,
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

  const parsed = GetProjectResponse.parse(project);
  const healthScore = await computeHealthScoreForProject(project.id);
  res.json({ ...parsed, healthScore });
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
