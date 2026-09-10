import { Router, type IRouter } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, workspacesTable } from "@workspace/db";
import { z } from "zod";
import { createOwnedWorkspace } from "../lib/workspace-foundation";
import { retireEmptyWorkspace } from "../lib/workspace-lifecycle";

const router: IRouter = Router();

const WorkspaceInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(["personal", "business", "client", "team"]).default("personal"),
});

const WorkspaceUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  type: z.enum(["personal", "business", "client", "team"]).optional(),
});

const activeWorkspaces = isNull(workspacesTable.deletedAt);
const publicWorkspaceFields = {
  id: workspacesTable.id,
  ownerUserId: workspacesTable.ownerUserId,
  name: workspacesTable.name,
  description: workspacesTable.description,
  type: workspacesTable.type,
  deletedAt: workspacesTable.deletedAt,
  createdAt: workspacesTable.createdAt,
  updatedAt: workspacesTable.updatedAt,
};

function publicWorkspace<T extends Record<string, unknown>>(workspace: T): Omit<T, "systemKey"> {
  const { systemKey: _systemKey, ...safe } = workspace as Record<string, unknown>;
  return safe as Omit<T, "systemKey">;
}

router.get("/workspaces", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const userId = req.userId;

  const rows = await db
    .select(publicWorkspaceFields)
    .from(workspacesTable)
    .where(and(eq(workspacesTable.ownerUserId, userId), activeWorkspaces))
    .orderBy(desc(workspacesTable.createdAt));

  res.json(rows.map(publicWorkspace));
});

router.post("/workspaces", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const parsed = WorkspaceInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const userId = req.userId;
  let workspace;
  try {
    workspace = await createOwnedWorkspace({ ownerUserId: userId, ...parsed.data });
  } catch {
    res.status(500).json({ error: "Failed to create workspace" });
    return;
  }

  res.status(201).json(publicWorkspace(workspace));
});

router.get("/workspaces/:id", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const userId = req.userId;
  const [workspace] = await db
    .select(publicWorkspaceFields)
    .from(workspacesTable)
    .where(
      and(eq(workspacesTable.id, id), eq(workspacesTable.ownerUserId, userId), activeWorkspaces),
    );

  if (!workspace) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }
  res.json(publicWorkspace(workspace));
});

router.patch("/workspaces/:id", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const parsed = WorkspaceUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const userId = req.userId;
  const [workspace] = await db
    .update(workspacesTable)
    .set({ ...parsed.data, updatedAt: sql`now()` })
    .where(
      and(eq(workspacesTable.id, id), eq(workspacesTable.ownerUserId, userId), activeWorkspaces),
    )
    .returning(publicWorkspaceFields);

  if (!workspace) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }
  res.json(workspace);
});

router.delete("/workspaces/:id", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const rawId = req.params.id;
  const id = Number(rawId);
  if (
    typeof rawId !== "string" ||
    !/^[0-9]+$/.test(rawId) ||
    !Number.isInteger(id) ||
    id < 1 ||
    id > 2147483647
  ) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const userId = req.userId;

  const outcome = await retireEmptyWorkspace({ workspaceId: id, userId });
  if (outcome === "not-found") {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }
  if (outcome === "only-workspace") {
    res.status(400).json({ error: "Cannot delete your only workspace" });
    return;
  }
  if (outcome === "projects-remain") {
    res.status(409).json({
      error:
        "This workspace still contains projects, including any in Trash. Resolve those projects before deleting the workspace.",
      code: "workspace_projects_remain",
    });
    return;
  }
  res.json({ deleted: true });
});

export default router;
