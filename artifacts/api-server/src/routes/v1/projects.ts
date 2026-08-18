/**
 * /api/v1/projects — stable versioned project CRUD.
 *
 * Auth: Bearer PAT token OR Clerk session cookie (handled by v1AuthMiddleware
 * in index.ts before this router is mounted).
 *
 * Routes:
 *   GET  /api/v1/projects          — list caller's projects
 *   GET  /api/v1/projects/:id      — get a single project
 *   POST /api/v1/projects          — create a project
 */

import { Router, type IRouter } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, projectsTable, projectArtifactsTable } from "@workspace/db";
import { checkV1ProjectAccess, requirePatScope } from "./access";
import type { PATRequest } from "../../lib/pat-auth";
import {
  ProjectWorkspaceUnavailableError,
  resolveProjectWorkspaceId,
} from "../../lib/workspace-tenancy";

const router: IRouter = Router();

// ── GET /api/v1/projects ──────────────────────────────────────────────────────
router.get("/projects", requirePatScope("projects:read"), async (req, res): Promise<void> => {
  const userId = req.userId!;

  const rows = await db
    .select({
      id: projectsTable.id,
      name: projectsTable.name,
      description: projectsTable.description,
      kind: projectsTable.kind,
      platform: projectsTable.platform,
      stack: projectsTable.stack,
      status: projectsTable.status,
      agentMode: projectsTable.agentMode,
      publicSlug: projectsTable.publicSlug,
      provisioningStatus: projectsTable.provisioningStatus,
      builderMode: projectsTable.builderMode,
      createdAt: projectsTable.createdAt,
      updatedAt: projectsTable.updatedAt,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.ownerId, userId), isNull(projectsTable.deletedAt)))
    .orderBy(desc(projectsTable.updatedAt));

  // If the token is project-scoped, only return the permitted project.
  const patProjectId = (req as unknown as PATRequest).patProjectId;
  const filtered =
    patProjectId !== null && patProjectId !== undefined
      ? rows.filter((r) => r.id === patProjectId)
      : rows;

  res.json({ projects: filtered, total: filtered.length });
});

// ── GET /api/v1/projects/:id ──────────────────────────────────────────────────
router.get("/projects/:id", requirePatScope("projects:read"), async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  if (!Number.isFinite(projectId)) {
    res.status(400).json({ error: "Invalid project id." });
    return;
  }

  if (!(await checkV1ProjectAccess(req, projectId))) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const [project] = await db
    .select({
      id: projectsTable.id,
      name: projectsTable.name,
      description: projectsTable.description,
      kind: projectsTable.kind,
      platform: projectsTable.platform,
      stack: projectsTable.stack,
      status: projectsTable.status,
      agentMode: projectsTable.agentMode,
      publicSlug: projectsTable.publicSlug,
      siteTitle: projectsTable.siteTitle,
      metaDescription: projectsTable.metaDescription,
      customDomain: projectsTable.customDomain,
      domainStatus: projectsTable.domainStatus,
      provisioningStatus: projectsTable.provisioningStatus,
      builderMode: projectsTable.builderMode,
      containerStatus: projectsTable.containerStatus,
      createdAt: projectsTable.createdAt,
      updatedAt: projectsTable.updatedAt,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  res.json({ project });
});

// ── POST /api/v1/projects ─────────────────────────────────────────────────────
router.post("/projects", requirePatScope("projects:write"), async (req, res): Promise<void> => {
  // Project-scoped PATs cannot create new projects (the scope is tied to a
  // specific existing project, so creating a new one is out of scope).
  if (
    (req as unknown as PATRequest).patProjectId !== null &&
    (req as unknown as PATRequest).patProjectId !== undefined
  ) {
    res.status(403).json({
      error: "Project-scoped tokens cannot create new projects. Use a user-scoped token.",
    });
    return;
  }

  const { name, description, kind, stack } = req.body as {
    name?: unknown;
    description?: unknown;
    kind?: unknown;
    stack?: unknown;
  };

  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required." });
    return;
  }

  const resolvedKind = typeof kind === "string" && kind.trim() ? kind.trim() : "web";

  const platformMap: Record<string, string> = {
    "mobile-ios": "ios",
    "mobile-android": "android",
    "mobile-cross": "cross",
  };
  const platform = platformMap[resolvedKind] ?? "web";
  const isMobile = platform !== "web";

  const resolvedStack =
    !isMobile && typeof stack === "string" && stack.trim() ? stack.trim() : "react-vite";

  const projectFormat = resolvedStack === "react-vite" && !isMobile ? "react-vite" : "static-html";

  let workspaceId: number;
  try {
    workspaceId = await resolveProjectWorkspaceId({ userId: req.userId! });
  } catch (error) {
    if (error instanceof ProjectWorkspaceUnavailableError) {
      res.status(409).json({ error: error.code });
      return;
    }
    throw error;
  }

  const [project] = await db
    .insert(projectsTable)
    .values({
      ownerId: req.userId!,
      workspaceId,
      name: name.trim().slice(0, 120),
      description: typeof description === "string" ? description.trim().slice(0, 500) : null,
      kind: resolvedKind,
      platform,
      stack: resolvedStack,
      projectFormat,
      builderMode: "agentic",
      provisioningStatus: "provisioning",
    })
    .returning({
      id: projectsTable.id,
      name: projectsTable.name,
      description: projectsTable.description,
      kind: projectsTable.kind,
      platform: projectsTable.platform,
      stack: projectsTable.stack,
      status: projectsTable.status,
      agentMode: projectsTable.agentMode,
      provisioningStatus: projectsTable.provisioningStatus,
      builderMode: projectsTable.builderMode,
      createdAt: projectsTable.createdAt,
      updatedAt: projectsTable.updatedAt,
    });

  if (!project) {
    res.status(500).json({ error: "Failed to create project." });
    return;
  }

  // Seed a primary artifact so the project is usable immediately.
  const slug = resolvedKind.startsWith("mobile") ? "mobile" : "web";
  const artifactName = resolvedKind.startsWith("mobile") ? "Mobile app" : "Web app";
  await db.insert(projectArtifactsTable).values({
    projectId: project.id,
    kind: resolvedKind,
    platform,
    projectFormat,
    stack: resolvedStack,
    name: artifactName,
    slug,
    isPrimary: true,
    status: "draft",
  });

  res.status(201).json({ project });
});

export default router;
