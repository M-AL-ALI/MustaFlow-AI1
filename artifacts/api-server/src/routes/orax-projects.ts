/**
 * Orax Project Workspace — Phase 2G/2H routes.
 *
 * Cloud-first project workspace: create/manage Orax Projects, attach
 * execution sources (local folder, GitHub repo), start threads inside
 * projects, send messages, and continue threads by resolving the active
 * execution source. Every query is userId-scoped; cross-account access
 * returns 404.
 *
 * Routes (Phase 2G):
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
 * Routes (Phase 2H — execution binding):
 *   GET    /api/orax/projects/:projectId/threads/:threadId/context
 *   POST   /api/orax/projects/:projectId/threads/:threadId/messages
 *   POST   /api/orax/projects/:projectId/threads/:threadId/continue
 *
 * All routes require Clerk auth (mounted after attachUser).
 */

import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  oraxProjectsTable,
  oraxProjectSourcesTable,
  oraxThreadsTable,
  oraxThreadMessagesTable,
  oraxHostsTable,
  oraxDesktopActionsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";

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

// ── Phase 2H: Execution context resolution ────────────────────────────────────

type SourceRow = {
  id: string;
  type: string;
  displayName: string | null;
  localPath: string | null;
  repoUrl: string | null;
  hostId: string | null;
  status: string;
};

type ExecContext =
  | { canExecute: false; mode: "chat_only"; source: null; host: null; blockReason: string }
  | { canExecute: false; mode: "local" | "cloud"; source: SourceRow; host: { id: string; deviceName: string; status: string } | null; blockReason: string }
  | { canExecute: true; mode: "local" | "cloud"; source: SourceRow; host: { id: string; deviceName: string; status: string } | null; blockReason: null };

/**
 * Resolves the active execution source for a project thread.
 * Priority: defaultSourceId → first active source.
 * For local_folder/worktree sources, also verifies the bound desktop host
 * is online and not revoked. Returns a `canExecute` flag plus block reason.
 */
async function resolveProjectExecutionContext(
  userId: string,
  projectId: string,
  defaultSourceId: string | null,
): Promise<ExecContext> {
  const sources = await db
    .select()
    .from(oraxProjectSourcesTable)
    .where(
      and(
        eq(oraxProjectSourcesTable.projectId, projectId),
        eq(oraxProjectSourcesTable.userId, userId),
      ),
    );

  let source = defaultSourceId
    ? sources.find((s) => s.id === defaultSourceId && s.status === "active")
    : undefined;
  if (!source) {
    source = sources.find((s) => s.status === "active");
  }

  if (!source) {
    return {
      canExecute: false,
      mode: "chat_only",
      source: null,
      host: null,
      blockReason:
        "No active execution source found. Attach a local folder on desktop or link a GitHub repository to run code in this project.",
    };
  }

  const sourceOut: SourceRow = {
    id: source.id,
    type: source.type,
    displayName: source.displayName,
    localPath: source.localPath,
    repoUrl: source.repoUrl,
    hostId: source.hostId,
    status: source.status,
  };

  if (source.type === "local_folder" || source.type === "worktree") {
    if (!source.hostId) {
      return {
        canExecute: false,
        mode: "local",
        source: sourceOut,
        host: null,
        blockReason:
          "This local folder is not bound to a desktop host. Open Orax Desktop and reconnect the folder.",
      };
    }

    const [host] = await db
      .select()
      .from(oraxHostsTable)
      .where(and(eq(oraxHostsTable.id, source.hostId), eq(oraxHostsTable.userId, userId)))
      .limit(1);

    if (!host) {
      return {
        canExecute: false,
        mode: "local",
        source: sourceOut,
        host: null,
        blockReason: "Desktop host not found. Re-pair your desktop to restore execution.",
      };
    }

    if (host.revokedAt) {
      return {
        canExecute: false,
        mode: "local",
        source: sourceOut,
        host: { id: host.id, deviceName: host.deviceName, status: "revoked" },
        blockReason: "Desktop host has been revoked.",
      };
    }

    if (host.status !== "online") {
      return {
        canExecute: false,
        mode: "local",
        source: sourceOut,
        host: { id: host.id, deviceName: host.deviceName, status: host.status ?? "offline" },
        blockReason: `Desktop offline — open Orax Desktop on ${host.deviceName} to run code.`,
      };
    }

    return {
      canExecute: true,
      mode: "local",
      source: sourceOut,
      host: { id: host.id, deviceName: host.deviceName, status: host.status ?? "online" },
      blockReason: null,
    };
  }

  if (source.type === "github_repo" || source.type === "cloud_env") {
    return {
      canExecute: true,
      mode: "cloud",
      source: sourceOut,
      host: null,
      blockReason: null,
    };
  }

  return {
    canExecute: false,
    mode: "chat_only",
    source: null,
    host: null,
    blockReason: "Unsupported execution source type.",
  };
}

// ── Phase 2H: GET /api/orax/projects/:projectId/threads/:threadId/messages ────

/**
 * Lists messages in a project thread in ascending chronological order.
 * Returns up to 200 most recent messages (sufficient for all current UIs).
 */
router.get("/api/orax/projects/:projectId/threads/:threadId/messages", async (req, res) => {
  const userId = req.userId!;
  const { projectId, threadId } = req.params;

  const project = await requireProject(userId, projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const thread = await requireThread(userId, threadId);
  if (!thread || thread.projectId !== projectId) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  const messages = await db
    .select()
    .from(oraxThreadMessagesTable)
    .where(eq(oraxThreadMessagesTable.threadId, threadId))
    .orderBy(oraxThreadMessagesTable.createdAt)
    .limit(200);

  res.json({ messages });
});

// ── Phase 2H: GET /api/orax/projects/:projectId/threads/:threadId/context ─────

/**
 * Returns execution readiness for a project thread. Used by web/mobile to
 * show the correct source status and host online badge before the user sends
 * a message. Does NOT modify any state.
 */
router.get("/api/orax/projects/:projectId/threads/:threadId/context", async (req, res) => {
  const userId = req.userId!;
  const { projectId, threadId } = req.params;

  const project = await requireProject(userId, projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const thread = await requireThread(userId, threadId);
  if (!thread || thread.projectId !== projectId) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  const ctx = await resolveProjectExecutionContext(
    userId,
    projectId,
    project.defaultExecutionSourceId ?? null,
  );

  res.json({ context: ctx, threadMode: thread.mode });
});

// ── Phase 2H: POST /api/orax/projects/:projectId/threads/:threadId/messages ──

const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  role: z.enum(["user", "assistant", "system"]).default("user"),
});

/**
 * Saves a message to a project thread. Returns the saved message row.
 * The caller provides the role ("user" for human turns, "assistant" for agent).
 * Touching the thread also bumps its updatedAt and marks it active.
 */
router.post("/api/orax/projects/:projectId/threads/:threadId/messages", async (req, res) => {
  const userId = req.userId!;
  const { projectId, threadId } = req.params;

  const parsed = sendMessageSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid message", details: parsed.error.issues });
    return;
  }

  const project = await requireProject(userId, projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const thread = await requireThread(userId, threadId);
  if (!thread || thread.projectId !== projectId) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  const { content, role } = parsed.data;
  const now = new Date();

  const [message] = await db
    .insert(oraxThreadMessagesTable)
    .values({ threadId, role, content, createdAt: now })
    .returning();

  await db
    .update(oraxThreadsTable)
    .set({ updatedAt: now, status: "active" })
    .where(and(eq(oraxThreadsTable.id, threadId), eq(oraxThreadsTable.userId, userId)));

  res.status(201).json({ message });
});

// ── Phase 2H: POST /api/orax/projects/:projectId/threads/:threadId/continue ──

const continueThreadSchema = z.object({
  userMessage: z.string().trim().min(1).max(20_000).optional(),
  executionSourceId: z.string().max(80).optional(),
});

/**
 * Continues a project thread using resolved project/source/host context.
 *
 * Steps:
 *  1. Verify project + thread ownership.
 *  2. Optionally save the user message.
 *  3. If thread.mode === "chat_only" → save informational assistant message
 *     and return without queuing execution.
 *  4. Resolve active execution source (defaultExecutionSourceId → first active).
 *  5. If source not found or host offline → save assistant message with
 *     blockReason and return (no action created).
 *  6. If source is local (has desktop host online) → queue a
 *     run_project_thread desktop action with projectId/threadId/executionSourceId
 *     in the payload, save "Queued for desktop" assistant message.
 *  7. Cloud sources → return context (cloud execution is a future phase).
 */
router.post("/api/orax/projects/:projectId/threads/:threadId/continue", async (req, res) => {
  const userId = req.userId!;
  const { projectId, threadId } = req.params;

  const parsed = continueThreadSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const project = await requireProject(userId, projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const thread = await requireThread(userId, threadId);
  if (!thread || thread.projectId !== projectId) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  const { userMessage, executionSourceId } = parsed.data;
  const now = new Date();

  if (userMessage) {
    await db
      .insert(oraxThreadMessagesTable)
      .values({ threadId, role: "user", content: userMessage, createdAt: now });
  }

  // Refuse execution when thread is in chat-only planning mode
  if (thread.mode === "chat_only") {
    const [assistantMsg] = await db
      .insert(oraxThreadMessagesTable)
      .values({
        threadId,
        role: "assistant",
        content:
          "This thread is in planning mode. Attach a local folder or GitHub repository to this project to enable code execution.",
        createdAt: new Date(now.getTime() + 1),
      })
      .returning();

    res.json({
      context: {
        canExecute: false,
        mode: "chat_only",
        source: null,
        host: null,
        blockReason: "Thread is in chat-only planning mode.",
      },
      action: null,
      message: assistantMsg ?? null,
    });
    return;
  }

  const overrideSourceId = executionSourceId ?? project.defaultExecutionSourceId ?? null;
  const ctx = await resolveProjectExecutionContext(userId, projectId, overrideSourceId);

  if (!ctx.canExecute) {
    const [assistantMsg] = await db
      .insert(oraxThreadMessagesTable)
      .values({
        threadId,
        role: "assistant",
        content: ctx.blockReason,
        createdAt: new Date(now.getTime() + 1),
      })
      .returning();

    res.json({ context: ctx, action: null, message: assistantMsg ?? null });
    return;
  }

  // Cloud sources — skip desktop action (handled in a future phase)
  if (ctx.mode === "cloud") {
    res.json({ context: ctx, action: null, message: null });
    return;
  }

  // Local source with online host — queue desktop action
  const hostId = ctx.host!.id;
  const iKey = `project-thread:${projectId}:${threadId}:${randomUUID()}`;

  const [action] = await db
    .insert(oraxDesktopActionsTable)
    .values({
      userId,
      hostId,
      threadId,
      type: "run_project_thread",
      status: "queued",
      payload: {
        projectId,
        threadId,
        executionSourceId: ctx.source!.id,
        sourceLocalPath: ctx.source!.localPath,
        userMessage: userMessage ?? null,
      },
      idempotencyKey: iKey,
    })
    .returning();

  const [assistantMsg] = await db
    .insert(oraxThreadMessagesTable)
    .values({
      threadId,
      role: "assistant",
      content: `Queued for desktop execution on ${ctx.host!.deviceName}. Orax Desktop will pick this up shortly.`,
      createdAt: new Date(now.getTime() + 1),
    })
    .returning();

  await db
    .update(oraxThreadsTable)
    .set({ updatedAt: now, status: "active" })
    .where(and(eq(oraxThreadsTable.id, threadId), eq(oraxThreadsTable.userId, userId)));

  res.status(201).json({ context: ctx, action: action ?? null, message: assistantMsg ?? null });
});

// ── Phase 2L: POST /api/orax/projects/:projectId/threads/:threadId/apply-patch ─

const applyPatchBodySchema = z.object({
  messageId: z.string().min(1).max(80),
});

/**
 * Queues an apply_project_patch desktop action from a project_patch_drafted message.
 *
 * Steps:
 *  1. Verify project + thread ownership.
 *  2. Look up the `project_patch_drafted` message by id.
 *  3. Extract enriched draftPatch (with newContent) + sourceLocalPath from payload.
 *  4. Verify at least one file has newContent (AI-enriched patch required).
 *  5. Find the most recent desktop action for this thread to get hostId.
 *  6. Queue apply_project_patch action to that host.
 *  7. Write project_patch_apply_queued system message.
 */
router.post(
  "/api/orax/projects/:projectId/threads/:threadId/apply-patch",
  async (req, res) => {
    const userId = req.userId!;
    const { projectId, threadId } = req.params;

    const parsed = applyPatchBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }
    const { messageId } = parsed.data;

    try {
      const project = await requireProject(projectId, userId);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const thread = await requireThread(threadId, userId);
      if (!thread || thread.projectId !== projectId) {
        res.status(404).json({ error: "Thread not found" });
        return;
      }

      // Look up the project_patch_drafted message
      const [msg] = await db
        .select()
        .from(oraxThreadMessagesTable)
        .where(
          and(
            eq(oraxThreadMessagesTable.id, messageId),
            eq(oraxThreadMessagesTable.threadId, threadId),
          ),
        )
        .limit(1);

      if (!msg) {
        res.status(404).json({ error: "Message not found" });
        return;
      }

      if (
        msg.eventType !== "project_patch_drafted" &&
        msg.eventType !== "project_fix_drafted"
      ) {
        res
          .status(422)
          .json({ error: "Message is not a project_patch_drafted or project_fix_drafted event" });
        return;
      }

      const msgPayload = (msg.payload ?? {}) as {
        draftPatch?: {
          changedFiles?: Array<{
            relativePath: string;
            operation: string;
            newContent?: string;
            originalHash?: string;
          }>;
        };
        sourceLocalPath?: string | null;
      };

      const changedFiles = msgPayload.draftPatch?.changedFiles ?? [];
      const enrichedFiles = changedFiles.filter((f) => f.newContent);
      if (enrichedFiles.length === 0) {
        res.status(422).json({
          error:
            "Patch has no AI-generated file content. Wait for patch generation to complete or re-trigger the thread.",
        });
        return;
      }

      const sourceLocalPath = msgPayload.sourceLocalPath ?? null;

      // Find the host from the most recent desktop action for this thread
      const [recentAction] = await db
        .select()
        .from(oraxDesktopActionsTable)
        .where(
          and(
            eq(oraxDesktopActionsTable.threadId, threadId),
            eq(oraxDesktopActionsTable.userId, userId),
          ),
        )
        .orderBy(desc(oraxDesktopActionsTable.createdAt))
        .limit(1);

      if (!recentAction?.hostId) {
        res.status(422).json({
          error: "No desktop host found for this thread. Re-run the thread to bind a host.",
        });
        return;
      }

      // Check host exists and belongs to user
      const [host] = await db
        .select()
        .from(oraxHostsTable)
        .where(
          and(eq(oraxHostsTable.id, recentAction.hostId), eq(oraxHostsTable.userId, userId)),
        )
        .limit(1);

      if (!host) {
        res.status(404).json({ error: "Host not found" });
        return;
      }

      const iKey = `apply-patch:${threadId}:${messageId}`;
      const now = new Date();

      const [action] = await db
        .insert(oraxDesktopActionsTable)
        .values({
          userId,
          hostId: recentAction.hostId,
          threadId,
          type: "apply_project_patch",
          status: "queued",
          payload: {
            projectId,
            threadId,
            messageId,
            sourceLocalPath,
            patches: enrichedFiles.map((f) => ({
              relativePath: f.relativePath,
              operation: f.operation,
              newContent: f.newContent!,
              originalHash: f.originalHash ?? null,
            })),
          },
          idempotencyKey: iKey,
        })
        .onConflictDoNothing({ target: oraxDesktopActionsTable.idempotencyKey })
        .returning();

      const [sysmsg] = await db
        .insert(oraxThreadMessagesTable)
        .values({
          threadId,
          role: "system",
          content: `Patch apply queued — ${enrichedFiles.length} file${enrichedFiles.length === 1 ? "" : "s"} on ${host.deviceName}. Orax Desktop will pick this up shortly.`,
          eventType: "project_patch_apply_queued",
          createdAt: new Date(now.getTime() + 1),
          payload: { actionId: action?.id, hostId: recentAction.hostId, messageId },
        })
        .returning();

      logger.info(
        { component: "orax-projects", userId, projectId, threadId, actionId: action?.id },
        "apply_project_patch queued",
      );

      res.status(201).json({ action: action ?? null, message: sysmsg ?? null });
    } catch (err) {
      logger.error({ component: "orax-projects", err, projectId, threadId }, "apply-patch failed");
      res.status(500).json({ error: "Failed to queue patch apply" });
    }
  },
);

// ── Phase 2M: prepare-fix endpoint ──────────────────────────────────────────

router.post(
  "/orax/projects/:projectId/threads/:threadId/prepare-fix",
  async (req, res) => {
    const userId = req.userId!;
    const { projectId, threadId } = req.params as {
      projectId: string;
      threadId: string;
    };

    try {
      // Verify project ownership
      const [project] = await db
        .select()
        .from(oraxProjectsTable)
        .where(
          and(
            eq(oraxProjectsTable.id, projectId),
            eq(oraxProjectsTable.userId, userId),
          ),
        )
        .limit(1);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      // Verify thread belongs to project
      const [thread] = await db
        .select()
        .from(oraxThreadsTable)
        .where(
          and(
            eq(oraxThreadsTable.id, threadId),
            eq(oraxThreadsTable.projectId, projectId),
            eq(oraxThreadsTable.userId, userId),
          ),
        )
        .limit(1);
      if (!thread) {
        res.status(404).json({ error: "Thread not found" });
        return;
      }

      // Find sourceLocalPath + hostId from most recent desktop action for this thread
      const [recentAction] = await db
        .select()
        .from(oraxDesktopActionsTable)
        .where(
          and(
            eq(oraxDesktopActionsTable.threadId, threadId),
            eq(oraxDesktopActionsTable.userId, userId),
          ),
        )
        .orderBy(desc(oraxDesktopActionsTable.createdAt))
        .limit(1);

      if (!recentAction?.hostId) {
        res.status(422).json({
          error: "No desktop host found for this thread. Re-run the thread to bind a host.",
        });
        return;
      }

      const actionPayload = (recentAction.payload ?? {}) as {
        sourceLocalPath?: string;
        executionSourceId?: string;
        projectId?: string;
        userMessage?: string;
      };
      const sourceLocalPath = actionPayload.sourceLocalPath ?? null;

      // Get most recent user message for context
      const [recentUserMsg] = await db
        .select()
        .from(oraxThreadMessagesTable)
        .where(
          and(
            eq(oraxThreadMessagesTable.threadId, threadId),
            eq(oraxThreadMessagesTable.role, "user"),
          ),
        )
        .orderBy(desc(oraxThreadMessagesTable.createdAt))
        .limit(1);
      const userMessage = recentUserMsg?.content ?? "";

      // Check host exists and belongs to user
      const [host] = await db
        .select()
        .from(oraxHostsTable)
        .where(
          and(eq(oraxHostsTable.id, recentAction.hostId), eq(oraxHostsTable.userId, userId)),
        )
        .limit(1);

      if (!host) {
        res.status(404).json({ error: "Host not found" });
        return;
      }

      // Phase 2N: check whether the most recent thread message is a verification failure.
      // If so, queue draft_project_fix (auto-fix loop) with the failed check output.
      // Otherwise fall back to draft_project_patch (re-draft from scratch).
      const [latestVerifyFailMsg] = await db
        .select()
        .from(oraxThreadMessagesTable)
        .where(
          and(
            eq(oraxThreadMessagesTable.threadId, threadId),
            eq(oraxThreadMessagesTable.eventType, "project_patch_verification_failed"),
          ),
        )
        .orderBy(desc(oraxThreadMessagesTable.createdAt))
        .limit(1);

      const failedChecks = latestVerifyFailMsg
        ? ((latestVerifyFailMsg.payload as { checks?: unknown })?.checks ?? [])
        : null;

      // Find the most recent drafted patch for changedFiles + summary context
      const [latestDraftMsg] = await db
        .select()
        .from(oraxThreadMessagesTable)
        .where(
          and(
            eq(oraxThreadMessagesTable.threadId, threadId),
            inArray(oraxThreadMessagesTable.eventType, [
              "project_patch_drafted",
              "project_fix_drafted",
            ]),
          ),
        )
        .orderBy(desc(oraxThreadMessagesTable.createdAt))
        .limit(1);

      const latestDraftPayload = (latestDraftMsg?.payload ?? {}) as {
        draftPatch?: { summary?: string; changedFiles?: Array<{ relativePath: string; operation: string }> };
      };
      const changedFiles = latestDraftPayload.draftPatch?.changedFiles ?? [];
      const previousPatchSummary = latestDraftPayload.draftPatch?.summary ?? "";

      const useAutoFix = failedChecks !== null && Array.isArray(failedChecks) && changedFiles.length > 0;
      const actionType = useAutoFix ? "draft_project_fix" : "draft_project_patch";

      const iKey = `prepare-fix:${threadId}:${Date.now()}`;
      const [action] = await db
        .insert(oraxDesktopActionsTable)
        .values({
          userId,
          hostId: recentAction.hostId,
          threadId,
          type: actionType,
          status: "queued",
          payload: useAutoFix
            ? {
                projectId,
                threadId,
                executionSourceId: actionPayload.executionSourceId ?? null,
                sourceLocalPath,
                userMessage,
                originalUserMessage: userMessage,
                previousPatchSummary,
                failedChecks,
                changedFiles,
              }
            : {
                projectId,
                threadId,
                executionSourceId: actionPayload.executionSourceId ?? null,
                sourceLocalPath,
                userMessage,
                preparingFix: true,
              },
          idempotencyKey: iKey,
        })
        .onConflictDoNothing({ target: oraxDesktopActionsTable.idempotencyKey })
        .returning();

      const [sysmsg] = await db
        .insert(oraxThreadMessagesTable)
        .values({
          threadId,
          role: "system",
          content: useAutoFix
            ? `Preparing auto-fix proposal on ${host.deviceName}. Orax Desktop will pick this up shortly.`
            : `Preparing fix proposal on ${host.deviceName}. Orax Desktop will pick this up shortly.`,
          eventType: "project_patch_fix_queued",
          payload: { actionId: action?.id ?? null, hostId: recentAction.hostId },
        })
        .returning();

      logger.info(
        { component: "orax-projects", userId, projectId, threadId, actionId: action?.id, actionType },
        "prepare-fix queued draft_project_patch",
      );

      res.status(201).json({ action: action ?? null, message: sysmsg ?? null });
    } catch (err) {
      logger.error(
        { component: "orax-projects", err, projectId, threadId },
        "prepare-fix failed",
      );
      res.status(500).json({ error: "Failed to queue fix preparation" });
    }
  },
);

// ── Phase 3B: prepare pull request endpoint ───────────────────────────────────

router.post(
  "/orax/projects/:projectId/threads/:threadId/prepare-pr",
  async (req, res) => {
    const userId = req.userId!;
    const { projectId, threadId } = req.params as {
      projectId: string;
      threadId: string;
    };

    try {
      // Verify project ownership
      const [project] = await db
        .select()
        .from(oraxProjectsTable)
        .where(
          and(
            eq(oraxProjectsTable.id, projectId),
            eq(oraxProjectsTable.userId, userId),
          ),
        )
        .limit(1);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      // Verify thread belongs to project
      const [thread] = await db
        .select()
        .from(oraxThreadsTable)
        .where(
          and(
            eq(oraxThreadsTable.id, threadId),
            eq(oraxThreadsTable.projectId, projectId),
            eq(oraxThreadsTable.userId, userId),
          ),
        )
        .limit(1);
      if (!thread) {
        res.status(404).json({ error: "Thread not found" });
        return;
      }

      // Confirm a verified message exists in this thread
      const [verifiedMsg] = await db
        .select()
        .from(oraxThreadMessagesTable)
        .where(
          and(
            eq(oraxThreadMessagesTable.threadId, threadId),
            eq(oraxThreadMessagesTable.eventType, "project_patch_verified"),
          ),
        )
        .orderBy(desc(oraxThreadMessagesTable.createdAt))
        .limit(1);

      if (!verifiedMsg) {
        res.status(422).json({
          error:
            "No verified patch found in this thread. Run verification before creating a pull request.",
        });
        return;
      }

      // Find sourceLocalPath + hostId from most recent desktop action for this thread
      const [recentAction] = await db
        .select()
        .from(oraxDesktopActionsTable)
        .where(
          and(
            eq(oraxDesktopActionsTable.threadId, threadId),
            eq(oraxDesktopActionsTable.userId, userId),
          ),
        )
        .orderBy(desc(oraxDesktopActionsTable.createdAt))
        .limit(1);

      if (!recentAction?.hostId) {
        res.status(422).json({
          error:
            "No desktop host found for this thread. Re-run the thread to bind a host.",
        });
        return;
      }

      const actionPayload = (recentAction.payload ?? {}) as {
        sourceLocalPath?: string;
        executionSourceId?: string;
        projectId?: string;
        changedFiles?: Array<{ relativePath: string; operation: string }>;
      };
      const sourceLocalPath = actionPayload.sourceLocalPath ?? null;

      if (!sourceLocalPath) {
        res.status(422).json({
          error:
            "Could not resolve local project path from the most recent action. Re-run the thread.",
        });
        return;
      }

      // Get changedFiles from the most recent applied or verified patch message
      const [appliedMsg] = await db
        .select()
        .from(oraxThreadMessagesTable)
        .where(
          and(
            eq(oraxThreadMessagesTable.threadId, threadId),
            inArray(oraxThreadMessagesTable.eventType, [
              "project_patch_applied",
              "project_fix_drafted",
              "project_patch_drafted",
            ]),
          ),
        )
        .orderBy(desc(oraxThreadMessagesTable.createdAt))
        .limit(1);

      const appliedPayload = (appliedMsg?.payload ?? {}) as {
        changedFiles?: Array<{ relativePath: string }>;
        draftPatch?: { changedFiles?: Array<{ relativePath: string }> };
      };
      const rawChangedFiles =
        appliedPayload.changedFiles ??
        appliedPayload.draftPatch?.changedFiles ??
        [];
      const changedFiles = rawChangedFiles.map((f) => f.relativePath).filter(Boolean);

      // Build project slug from name
      const projectSlug = project.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 32) || "patch";

      // Build commit message
      const commitMessage =
        `Orax: ${(thread.title ?? project.name).slice(0, 72)}\n\n` +
        `Applied and verified via Orax Desktop.\n` +
        `Project: ${project.name}\nThread: ${threadId}`;

      // Queue prepare_project_pr action
      const iKey = `prepare-pr:${threadId}:${Date.now()}`;
      const [action] = await db
        .insert(oraxDesktopActionsTable)
        .values({
          userId,
          hostId: recentAction.hostId,
          threadId,
          type: "prepare_project_pr",
          status: "queued",
          payload: {
            projectId,
            threadId,
            executionSourceId: actionPayload.executionSourceId ?? null,
            sourceLocalPath,
            changedFiles,
            commitMessage,
            projectSlug,
          },
          idempotencyKey: iKey,
        })
        .onConflictDoNothing({ target: oraxDesktopActionsTable.idempotencyKey })
        .returning();

      // Insert system message
      const [host] = await db
        .select()
        .from(oraxHostsTable)
        .where(
          and(eq(oraxHostsTable.id, recentAction.hostId), eq(oraxHostsTable.userId, userId)),
        )
        .limit(1);

      const [sysmsg] = await db
        .insert(oraxThreadMessagesTable)
        .values({
          threadId,
          role: "system",
          content: `Preparing pull request branch on ${host?.deviceName ?? "desktop"}. Orax Desktop will pick this up shortly.`,
          eventType: "project_pr_prepare_queued",
          payload: { actionId: action?.id ?? null, hostId: recentAction.hostId },
        })
        .returning();

      logger.info(
        {
          component: "orax-projects",
          userId,
          projectId,
          threadId,
          actionId: action?.id,
        },
        "prepare-pr queued prepare_project_pr",
      );

      res.status(201).json({ action: action ?? null, message: sysmsg ?? null });
    } catch (err) {
      logger.error(
        { component: "orax-projects", err, projectId, threadId },
        "prepare-pr failed",
      );
      res.status(500).json({ error: "Failed to queue pull request preparation" });
    }
  },
);

export default router;
