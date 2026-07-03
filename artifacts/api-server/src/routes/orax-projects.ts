/**
 * Orax Project Workspace — Phase 2G routes.
 *
 * Cloud-first project workspace: create/manage Orax Projects, attach
 * execution sources (local folder, GitHub repo), and start threads inside
 * projects. Every query is userId-scoped; cross-account access returns 404.
 *
 * Routes:
 *   GET    /api/orax/projects
 *   POST   /api/orax/projects
 *   GET    /api/orax/projects/:projectId
 *   PATCH  /api/orax/projects/:projectId
 *   POST   /api/orax/projects/:projectId/archive
 *   GET    /api/orax/projects/:projectId/sources
 *   POST   /api/orax/projects/:projectId/sources/local-folder
 *   POST   /api/orax/projects/:projectId/sources/github
 *   PATCH  /api/orax/projects/:projectId/sources/:sourceId
 *   DELETE /api/orax/projects/:projectId/sources/:sourceId
 *   GET    /api/orax/projects/:projectId/threads
 *   POST   /api/orax/projects/:projectId/threads
 *   PATCH  /api/orax/threads/:threadId
 *   POST   /api/orax/threads/:threadId/archive
 *
 * All routes require Clerk auth (mounted after attachUser).
 */

import { Router } from "express";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  oraxProjectsTable,
  oraxProjectSourcesTable,
  oraxThreadsTable,
  oraxThreadMessagesTable,
} from "@workspace/db";

const router = Router();

// ── Zod schemas ────────────────────────────────────────────────────────────────

const createProjectSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  icon: z.string().max(64).optional(),
  color: z.string().max(32).optional(),
  memory: z.record(z.unknown()).optional(),
  settings: z.record(z.unknown()).optional(),
});

const patchProjectSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(1000).nullable().optional(),
  icon: z.string().max(64).nullable().optional(),
  color: z.string().max(32).nullable().optional(),
  defaultExecutionSourceId: z.string().nullable().optional(),
  memory: z.record(z.unknown()).optional(),
  settings: z.record(z.unknown()).optional(),
});

const attachLocalFolderSchema = z.object({
  localPath: z.string().min(1),
  displayName: z.string().min(1).max(120).optional(),
  hostId: z.string().min(1),
});

const attachGithubSchema = z.object({
  repoUrl: z.string().url(),
  displayName: z.string().min(1).max(120).optional(),
  branch: z.string().max(120).optional(),
  hostId: z.string().optional(),
});

const patchSourceSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  status: z.enum(["active", "missing", "disconnected", "archived"]).optional(),
  localPath: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  lastSeenAt: z.string().datetime().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const createThreadSchema = z.object({
  title: z.string().max(200).optional(),
  executionSourceId: z.string().optional(),
  hostId: z.string().optional(),
  mode: z.enum(["local", "worktree", "cloud", "ssh", "chat_only"]).optional(),
  initialMessage: z.string().max(4000).optional(),
});

const patchThreadSchema = z.object({
  title: z.string().max(200).nullable().optional(),
  status: z.enum(["idle", "active", "paused", "completed", "failed"]).optional(),
  mode: z.enum(["local", "worktree", "cloud", "ssh", "chat_only"]).optional(),
  executionSourceId: z.string().nullable().optional(),
  hostId: z.string().nullable().optional(),
  lastEvent: z.record(z.unknown()).nullable().optional(),
});

// ── Helper: resolve and assert ownership ───────────────────────────────────────

async function requireProject(projectId: string, userId: string) {
  const [project] = await db
    .select()
    .from(oraxProjectsTable)
    .where(and(eq(oraxProjectsTable.id, projectId), eq(oraxProjectsTable.userId, userId)))
    .limit(1);
  return project ?? null;
}

async function requireSource(sourceId: string, projectId: string, userId: string) {
  const [source] = await db
    .select()
    .from(oraxProjectSourcesTable)
    .where(
      and(
        eq(oraxProjectSourcesTable.id, sourceId),
        eq(oraxProjectSourcesTable.projectId, projectId),
        eq(oraxProjectSourcesTable.userId, userId),
      ),
    )
    .limit(1);
  return source ?? null;
}

async function requireThread(threadId: string, userId: string) {
  const [thread] = await db
    .select()
    .from(oraxThreadsTable)
    .where(and(eq(oraxThreadsTable.id, threadId), eq(oraxThreadsTable.userId, userId)))
    .limit(1);
  return thread ?? null;
}

// ── GET /api/orax/projects ─────────────────────────────────────────────────────

router.get("/orax/projects", async (req, res) => {
  const userId = req.userId!;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;

  const rows = await db
    .select()
    .from(oraxProjectsTable)
    .where(
      status
        ? and(eq(oraxProjectsTable.userId, userId), eq(oraxProjectsTable.status, status))
        : eq(oraxProjectsTable.userId, userId),
    )
    .orderBy(desc(oraxProjectsTable.updatedAt));

  res.json({ projects: rows });
});

// ── POST /api/orax/projects ────────────────────────────────────────────────────

router.post("/orax/projects", async (req, res) => {
  const userId = req.userId!;
  const parse = createProjectSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid request", details: parse.error.issues });
    return;
  }
  const { name, description, icon, color, memory, settings } = parse.data;

  const [project] = await db
    .insert(oraxProjectsTable)
    .values({
      userId,
      name,
      description: description ?? null,
      icon: icon ?? null,
      color: color ?? null,
      memory: memory ?? {},
      settings: settings ?? {},
    })
    .returning();

  res.status(201).json({ project });
});

// ── GET /api/orax/projects/:projectId ─────────────────────────────────────────

router.get("/orax/projects/:projectId", async (req, res) => {
  const userId = req.userId!;
  const project = await requireProject(req.params.projectId!, userId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json({ project });
});

// ── PATCH /api/orax/projects/:projectId ───────────────────────────────────────

router.patch("/orax/projects/:projectId", async (req, res) => {
  const userId = req.userId!;
  const project = await requireProject(req.params.projectId!, userId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const parse = patchProjectSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid request", details: parse.error.issues });
    return;
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (parse.data.name !== undefined) patch.name = parse.data.name;
  if (parse.data.description !== undefined) patch.description = parse.data.description;
  if (parse.data.icon !== undefined) patch.icon = parse.data.icon;
  if (parse.data.color !== undefined) patch.color = parse.data.color;
  if (parse.data.defaultExecutionSourceId !== undefined)
    patch.defaultExecutionSourceId = parse.data.defaultExecutionSourceId;
  if (parse.data.memory !== undefined) patch.memory = parse.data.memory;
  if (parse.data.settings !== undefined) patch.settings = parse.data.settings;

  const [updated] = await db
    .update(oraxProjectsTable)
    .set(patch)
    .where(and(eq(oraxProjectsTable.id, project.id), eq(oraxProjectsTable.userId, userId)))
    .returning();

  res.json({ project: updated });
});

// ── POST /api/orax/projects/:projectId/archive ────────────────────────────────

router.post("/orax/projects/:projectId/archive", async (req, res) => {
  const userId = req.userId!;
  const project = await requireProject(req.params.projectId!, userId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [updated] = await db
    .update(oraxProjectsTable)
    .set({ status: "archived", updatedAt: new Date() })
    .where(and(eq(oraxProjectsTable.id, project.id), eq(oraxProjectsTable.userId, userId)))
    .returning();

  res.json({ project: updated });
});

// ── GET /api/orax/projects/:projectId/sources ─────────────────────────────────

router.get("/orax/projects/:projectId/sources", async (req, res) => {
  const userId = req.userId!;
  const project = await requireProject(req.params.projectId!, userId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const sources = await db
    .select()
    .from(oraxProjectSourcesTable)
    .where(
      and(
        eq(oraxProjectSourcesTable.projectId, project.id),
        eq(oraxProjectSourcesTable.userId, userId),
      ),
    )
    .orderBy(desc(oraxProjectSourcesTable.createdAt));

  res.json({ sources });
});

// ── POST /api/orax/projects/:projectId/sources/local-folder ───────────────────

router.post("/orax/projects/:projectId/sources/local-folder", async (req, res) => {
  const userId = req.userId!;
  const project = await requireProject(req.params.projectId!, userId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const parse = attachLocalFolderSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid request", details: parse.error.issues });
    return;
  }

  const { localPath, displayName, hostId } = parse.data;

  const [source] = await db
    .insert(oraxProjectSourcesTable)
    .values({
      projectId: project.id,
      userId,
      hostId,
      type: "local_folder",
      displayName: displayName ?? localPath.split(/[/\\]/).pop() ?? localPath,
      localPath,
      status: "active",
      lastSeenAt: new Date(),
    })
    .returning();

  res.status(201).json({ source });
});

// ── POST /api/orax/projects/:projectId/sources/github ────────────────────────

router.post("/orax/projects/:projectId/sources/github", async (req, res) => {
  const userId = req.userId!;
  const project = await requireProject(req.params.projectId!, userId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const parse = attachGithubSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid request", details: parse.error.issues });
    return;
  }

  const { repoUrl, displayName, branch, hostId } = parse.data;
  const repoName = repoUrl.split("/").slice(-2).join("/").replace(/\.git$/, "");

  const [source] = await db
    .insert(oraxProjectSourcesTable)
    .values({
      projectId: project.id,
      userId,
      hostId: hostId ?? null,
      type: "github_repo",
      displayName: displayName ?? repoName,
      repoUrl,
      branch: branch ?? "main",
      status: "active",
    })
    .returning();

  res.status(201).json({ source });
});

// ── PATCH /api/orax/projects/:projectId/sources/:sourceId ─────────────────────

router.patch("/orax/projects/:projectId/sources/:sourceId", async (req, res) => {
  const userId = req.userId!;
  const project = await requireProject(req.params.projectId!, userId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const source = await requireSource(req.params.sourceId!, project.id, userId);
  if (!source) {
    res.status(404).json({ error: "Source not found" });
    return;
  }

  const parse = patchSourceSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid request", details: parse.error.issues });
    return;
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (parse.data.displayName !== undefined) patch.displayName = parse.data.displayName;
  if (parse.data.status !== undefined) patch.status = parse.data.status;
  if (parse.data.localPath !== undefined) patch.localPath = parse.data.localPath;
  if (parse.data.branch !== undefined) patch.branch = parse.data.branch;
  if (parse.data.lastSeenAt !== undefined)
    patch.lastSeenAt = parse.data.lastSeenAt ? new Date(parse.data.lastSeenAt) : null;
  if (parse.data.metadata !== undefined) patch.metadata = parse.data.metadata;

  const [updated] = await db
    .update(oraxProjectSourcesTable)
    .set(patch)
    .where(
      and(
        eq(oraxProjectSourcesTable.id, source.id),
        eq(oraxProjectSourcesTable.userId, userId),
      ),
    )
    .returning();

  res.json({ source: updated });
});

// ── DELETE /api/orax/projects/:projectId/sources/:sourceId ────────────────────

router.delete("/orax/projects/:projectId/sources/:sourceId", async (req, res) => {
  const userId = req.userId!;
  const project = await requireProject(req.params.projectId!, userId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const source = await requireSource(req.params.sourceId!, project.id, userId);
  if (!source) {
    res.status(404).json({ error: "Source not found" });
    return;
  }

  await db
    .delete(oraxProjectSourcesTable)
    .where(
      and(
        eq(oraxProjectSourcesTable.id, source.id),
        eq(oraxProjectSourcesTable.userId, userId),
      ),
    );

  res.json({ ok: true });
});

// ── GET /api/orax/projects/:projectId/threads ─────────────────────────────────

router.get("/orax/projects/:projectId/threads", async (req, res) => {
  const userId = req.userId!;
  const project = await requireProject(req.params.projectId!, userId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const threads = await db
    .select()
    .from(oraxThreadsTable)
    .where(
      and(
        eq(oraxThreadsTable.projectId, project.id),
        eq(oraxThreadsTable.userId, userId),
      ),
    )
    .orderBy(desc(oraxThreadsTable.updatedAt));

  res.json({ threads });
});

// ── POST /api/orax/projects/:projectId/threads ────────────────────────────────

router.post("/orax/projects/:projectId/threads", async (req, res) => {
  const userId = req.userId!;
  const project = await requireProject(req.params.projectId!, userId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const parse = createThreadSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid request", details: parse.error.issues });
    return;
  }

  const { title, executionSourceId, hostId, mode, initialMessage } = parse.data;

  // Determine thread mode: if an execution source is attached, use the
  // source type to infer mode; otherwise default to chat_only.
  let resolvedMode = mode ?? "chat_only";
  if (!mode && executionSourceId) {
    const [src] = await db
      .select()
      .from(oraxProjectSourcesTable)
      .where(
        and(
          eq(oraxProjectSourcesTable.id, executionSourceId),
          eq(oraxProjectSourcesTable.userId, userId),
        ),
      )
      .limit(1);
    if (src?.type === "local_folder" || src?.type === "worktree") resolvedMode = "local";
    else if (src?.type === "github_repo") resolvedMode = "local";
    else if (src?.type === "cloud_env") resolvedMode = "cloud";
    else if (src?.type === "ssh_host") resolvedMode = "ssh";
  }

  const [thread] = await db
    .insert(oraxThreadsTable)
    .values({
      userId,
      projectId: project.id,
      executionSourceId: executionSourceId ?? null,
      hostId: hostId ?? null,
      title: title ?? null,
      status: "idle",
      mode: resolvedMode,
    })
    .returning();

  // If an initial message was provided, persist it immediately.
  if (initialMessage?.trim()) {
    await db.insert(oraxThreadMessagesTable).values({
      threadId: thread.id,
      role: "user",
      content: initialMessage.trim(),
    });
  }

  res.status(201).json({ thread });
});

// ── PATCH /api/orax/threads/:threadId ─────────────────────────────────────────

router.patch("/orax/threads/:threadId", async (req, res) => {
  const userId = req.userId!;
  const thread = await requireThread(req.params.threadId!, userId);
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  const parse = patchThreadSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid request", details: parse.error.issues });
    return;
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (parse.data.title !== undefined) patch.title = parse.data.title;
  if (parse.data.status !== undefined) patch.status = parse.data.status;
  if (parse.data.mode !== undefined) patch.mode = parse.data.mode;
  if (parse.data.executionSourceId !== undefined)
    patch.executionSourceId = parse.data.executionSourceId;
  if (parse.data.hostId !== undefined) patch.hostId = parse.data.hostId;
  if (parse.data.lastEvent !== undefined) patch.lastEvent = parse.data.lastEvent;

  const [updated] = await db
    .update(oraxThreadsTable)
    .set(patch)
    .where(and(eq(oraxThreadsTable.id, thread.id), eq(oraxThreadsTable.userId, userId)))
    .returning();

  res.json({ thread: updated });
});

// ── POST /api/orax/threads/:threadId/archive ──────────────────────────────────

router.post("/orax/threads/:threadId/archive", async (req, res) => {
  const userId = req.userId!;
  const thread = await requireThread(req.params.threadId!, userId);
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  const [updated] = await db
    .update(oraxThreadsTable)
    .set({ status: "completed", updatedAt: new Date() })
    .where(and(eq(oraxThreadsTable.id, thread.id), eq(oraxThreadsTable.userId, userId)))
    .returning();

  res.json({ thread: updated });
});

export default router;
