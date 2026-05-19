import { Router, type IRouter } from "express";
import { desc, eq, isNull, or, and } from "drizzle-orm";
import { db, knowledgeEntriesTable, projectsTable } from "@workspace/db";
import type { KnowledgeSeverity, KnowledgeType } from "@workspace/db";
import { isAdminUser } from "../lib/adminAuth";

const router: IRouter = Router();

// GET /api/knowledge — list knowledge entries visible to the current user.
// Returns:
//   - globally approved entries (approvedForReuse = true)
//   - entries created by the current user (userId = req.userId)
// Query params: ?projectId=<id>  — also include project-specific entries, but
//   only if the requesting user owns that project (or is admin). Unauthorized
//   projectId is silently ignored so as not to leak project existence.
router.get("/knowledge", async (req, res): Promise<void> => {
  const projectIdParam = req.query.projectId;
  const rawProjectId =
    typeof projectIdParam === "string" && /^\d+$/.test(projectIdParam)
      ? parseInt(projectIdParam, 10)
      : null;

  const userId = req.userId;

  let authorizedProjectId: number | null = null;
  if (rawProjectId && userId) {
    const admin = await isAdminUser(userId);
    if (admin) {
      authorizedProjectId = rawProjectId;
    } else {
      const [proj] = await db
        .select({ id: projectsTable.id })
        .from(projectsTable)
        .where(
          and(
            eq(projectsTable.id, rawProjectId),
            eq(projectsTable.ownerId, userId),
            isNull(projectsTable.deletedAt),
          ),
        );
      if (proj) authorizedProjectId = rawProjectId;
    }
  }

  const conditions = [eq(knowledgeEntriesTable.approvedForReuse, true)];
  if (userId) {
    conditions.push(eq(knowledgeEntriesTable.userId, userId));
  }
  if (authorizedProjectId) {
    conditions.push(eq(knowledgeEntriesTable.projectId, authorizedProjectId));
  }

  const rows = await db
    .select()
    .from(knowledgeEntriesTable)
    .where(or(...conditions))
    .orderBy(desc(knowledgeEntriesTable.createdAt))
    .limit(100);

  res.json(rows);
});

// POST /api/knowledge — manually create a knowledge entry.
router.post("/knowledge", async (req, res): Promise<void> => {
  const body = req.body as {
    title?: string;
    content?: string;
    category?: string;
    type?: string;
    severity?: string;
    projectId?: number;
    tags?: string[];
  };

  if (!body.title || !body.content) {
    res.status(400).json({ error: "title and content are required" });
    return;
  }

  const [row] = await db
    .insert(knowledgeEntriesTable)
    .values({
      title: body.title,
      content: body.content,
      category: body.category ?? "note",
      type: body.type ?? "note",
      severity: body.severity ?? "info",
      projectId: body.projectId ?? null,
      userId: req.userId,
      tags: body.tags ? body.tags.join(",") : null,
      approvedForReuse: false,
    })
    .returning();

  res.status(201).json(row);
});

// PATCH /api/knowledge/:id — update a knowledge entry.
// Allowed if: current user owns the entry OR current user is admin/owner.
router.patch("/knowledge/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }

  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const body = req.body as {
    title?: string;
    content?: string;
    category?: string;
    type?: KnowledgeType;
    severity?: KnowledgeSeverity;
    approvedForReuse?: boolean;
  };

  const [existing] = await db
    .select()
    .from(knowledgeEntriesTable)
    .where(eq(knowledgeEntriesTable.id, id));

  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const isOwner = existing.userId === userId;
  const isAdmin = await isAdminUser(userId);

  if (!isOwner && !isAdmin) {
    res.status(403).json({ error: "Forbidden — you do not own this entry" });
    return;
  }

  const [updated] = await db
    .update(knowledgeEntriesTable)
    .set({
      ...(body.title !== undefined && { title: body.title }),
      ...(body.content !== undefined && { content: body.content }),
      ...(body.category !== undefined && { category: body.category }),
      ...(body.type !== undefined && { type: body.type }),
      ...(body.severity !== undefined && { severity: body.severity }),
      ...(body.approvedForReuse !== undefined && { approvedForReuse: body.approvedForReuse }),
    })
    .where(eq(knowledgeEntriesTable.id, id))
    .returning();

  res.json(updated);
});

// DELETE /api/knowledge/:id — delete a knowledge entry.
// Allowed if: current user owns the entry OR current user is admin/owner.
router.delete("/knowledge/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }

  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const [existing] = await db
    .select()
    .from(knowledgeEntriesTable)
    .where(eq(knowledgeEntriesTable.id, id));

  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const isOwner = existing.userId === userId;
  const isAdmin = await isAdminUser(userId);

  if (!isOwner && !isAdmin) {
    res.status(403).json({ error: "Forbidden — you do not own this entry" });
    return;
  }

  await db.delete(knowledgeEntriesTable).where(eq(knowledgeEntriesTable.id, id));

  res.json({ ok: true });
});

export default router;
