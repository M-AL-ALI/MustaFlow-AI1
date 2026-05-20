import { Router, type IRouter } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, workspacesTable } from "@workspace/db";
import { z } from "zod";

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

async function ensureDefaultWorkspace(userId: string) {
  const existing = await db
    .select()
    .from(workspacesTable)
    .where(and(eq(workspacesTable.ownerUserId, userId), activeWorkspaces))
    .limit(1);

  if (existing.length > 0) return existing[0];

  const [created] = await db
    .insert(workspacesTable)
    .values({ ownerUserId: userId, name: "My Workspace", type: "personal" })
    .returning();

  return created;
}

router.get("/workspaces", async (req, res): Promise<void> => {
  const userId = req.userId ?? "demo-user";
  await ensureDefaultWorkspace(userId);

  const rows = await db
    .select()
    .from(workspacesTable)
    .where(and(eq(workspacesTable.ownerUserId, userId), activeWorkspaces))
    .orderBy(desc(workspacesTable.createdAt));

  res.json(rows);
});

router.post("/workspaces", async (req, res): Promise<void> => {
  const parsed = WorkspaceInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const userId = req.userId ?? "demo-user";
  const [workspace] = await db
    .insert(workspacesTable)
    .values({ ownerUserId: userId, ...parsed.data })
    .returning();

  if (!workspace) {
    res.status(500).json({ error: "Failed to create workspace" });
    return;
  }

  res.status(201).json(workspace);
});

router.get("/workspaces/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const userId = req.userId ?? "demo-user";
  const [workspace] = await db
    .select()
    .from(workspacesTable)
    .where(
      and(eq(workspacesTable.id, id), eq(workspacesTable.ownerUserId, userId), activeWorkspaces),
    );

  if (!workspace) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }
  res.json(workspace);
});

router.patch("/workspaces/:id", async (req, res): Promise<void> => {
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

  const userId = req.userId ?? "demo-user";
  const [workspace] = await db
    .update(workspacesTable)
    .set({ ...parsed.data, updatedAt: sql`now()` })
    .where(
      and(eq(workspacesTable.id, id), eq(workspacesTable.ownerUserId, userId), activeWorkspaces),
    )
    .returning();

  if (!workspace) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }
  res.json(workspace);
});

router.delete("/workspaces/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const userId = req.userId ?? "demo-user";

  const existing = await db
    .select()
    .from(workspacesTable)
    .where(and(eq(workspacesTable.ownerUserId, userId), activeWorkspaces));

  if (existing.length <= 1) {
    res.status(400).json({ error: "Cannot delete your only workspace" });
    return;
  }

  const [workspace] = await db
    .update(workspacesTable)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(eq(workspacesTable.id, id), eq(workspacesTable.ownerUserId, userId), activeWorkspaces),
    )
    .returning();

  if (!workspace) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }
  res.json({ deleted: true });
});

export { ensureDefaultWorkspace };
export default router;
