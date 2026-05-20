import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { db, knowledgeEntriesTable, projectsTable } from "@workspace/db";
import { isAdminUser } from "../lib/adminAuth";
import type { SQL } from "drizzle-orm";

const router: IRouter = Router();

// GET /api/knowledge — list knowledge entries visible to the current user.
// Query params:
//   ?projectId=<id>  — entries for a specific project (+ global)
//   ?type=<type>     — filter by entry type
//   ?severity=<sev>  — filter by severity (info|warning|error)
//   ?archived=true   — include archived entries (default: only non-archived)
//   ?limit=<n>       — max entries to return (default 20, max 200)
//   ?offset=<n>      — pagination offset (default 0)
//
// Without projectId: if authenticated, returns entries for ALL of the user's projects
// plus global (approvedForReuse=true) entries. If unauthenticated, returns only global entries.
router.get("/knowledge", async (req, res): Promise<void> => {
  const projectIdParam = req.query.projectId;
  const projectId =
    typeof projectIdParam === "string" && /^\d+$/.test(projectIdParam)
      ? parseInt(projectIdParam, 10)
      : null;

  const typeFilter = typeof req.query.type === "string" ? req.query.type : null;
  const severityFilter = typeof req.query.severity === "string" ? req.query.severity : null;
  const categoryFilter = typeof req.query.category === "string" ? req.query.category : null;
  const approvedOnly = req.query.approvedOnly === "true";
  const includeArchived = req.query.archived === "true";
  const limit = Math.min(
    200,
    typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) || 20 : 20,
  );
  const offset = typeof req.query.offset === "string" ? parseInt(req.query.offset, 10) || 0 : 0;

  let projectCondition: SQL;

  if (projectId !== null) {
    // Specific project: entries for that project + global
    projectCondition = or(
      eq(knowledgeEntriesTable.approvedForReuse, true),
      eq(knowledgeEntriesTable.projectId, projectId),
    ) as SQL;
  } else if (req.userId) {
    // Authenticated, no project filter: return entries for ALL of the user's projects + global
    const ownedProjects = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(and(eq(projectsTable.ownerId, req.userId), isNull(projectsTable.deletedAt)));
    const ownedIds = ownedProjects.map((p) => p.id);

    if (ownedIds.length > 0) {
      projectCondition = or(
        eq(knowledgeEntriesTable.approvedForReuse, true),
        inArray(knowledgeEntriesTable.projectId, ownedIds),
      ) as SQL;
    } else {
      projectCondition = eq(knowledgeEntriesTable.approvedForReuse, true) as SQL;
    }
  } else {
    // Unauthenticated: only global entries
    projectCondition = eq(knowledgeEntriesTable.approvedForReuse, true) as SQL;
  }

  const conditions: SQL[] = [projectCondition];
  if (!includeArchived) conditions.push(isNull(knowledgeEntriesTable.archivedAt) as SQL);
  if (typeFilter) conditions.push(eq(knowledgeEntriesTable.type, typeFilter) as SQL);
  if (severityFilter) conditions.push(eq(knowledgeEntriesTable.severity, severityFilter) as SQL);
  if (categoryFilter) conditions.push(eq(knowledgeEntriesTable.category, categoryFilter) as SQL);
  if (approvedOnly) conditions.push(eq(knowledgeEntriesTable.approvedForReuse, true) as SQL);

  const whereClause = conditions.length === 1 ? conditions[0]! : and(...conditions);

  const rows = await db
    .select()
    .from(knowledgeEntriesTable)
    .where(whereClause)
    .orderBy(desc(knowledgeEntriesTable.createdAt))
    .limit(limit)
    .offset(offset);

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

// PATCH /api/knowledge/:id — update annotation, approvedForReuse, or archivedAt.
// Authorization: requester must own the entry (entry.userId === req.userId) OR be admin.
// System entries (userId = null) can only be updated by admin.
router.patch("/knowledge/:id", async (req, res): Promise<void> => {
  const entryId = parseInt(req.params.id, 10);
  if (!Number.isFinite(entryId)) {
    res.status(400).json({ error: "Invalid entry id" });
    return;
  }

  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const [existing] = await db
    .select()
    .from(knowledgeEntriesTable)
    .where(eq(knowledgeEntriesTable.id, entryId));

  if (!existing) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }

  // Authorization:
  // - Entry has an owner: only owner can edit (or admin)
  // - Entry has no owner (system): only admin can edit
  const isOwner = existing.userId !== null && existing.userId === userId;
  const isAdmin = await isAdminUser(userId);

  if (!isOwner && !isAdmin) {
    res.status(403).json({ error: "You do not have permission to update this entry" });
    return;
  }

  const body = req.body as {
    annotation?: string | null;
    approvedForReuse?: boolean;
    archived?: boolean;
  };

  const updates: Partial<{
    annotation: string | null;
    approvedForReuse: boolean;
    archivedAt: Date | null;
  }> = {};

  if ("annotation" in body) updates.annotation = body.annotation ?? null;
  if (typeof body.approvedForReuse === "boolean") updates.approvedForReuse = body.approvedForReuse;
  if (typeof body.archived === "boolean") updates.archivedAt = body.archived ? new Date() : null;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }

  const [updated] = await db
    .update(knowledgeEntriesTable)
    .set(updates)
    .where(eq(knowledgeEntriesTable.id, entryId))
    .returning();

  res.json(updated);
});

export default router;
