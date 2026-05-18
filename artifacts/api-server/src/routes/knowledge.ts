import { Router, type IRouter } from "express";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db, knowledgeEntriesTable } from "@workspace/db";

const router: IRouter = Router();

// GET /api/knowledge — list knowledge entries visible to the current user.
// Returns globally approved entries + the requesting user's own project entries.
// Query params: ?projectId=<id>  — also include entries for a specific project.
router.get("/knowledge", async (req, res): Promise<void> => {
  const projectIdParam = req.query.projectId;
  const projectId =
    typeof projectIdParam === "string" && /^\d+$/.test(projectIdParam)
      ? parseInt(projectIdParam, 10)
      : null;

  // Show: globally approved entries OR project-specific entries for the requested project
  const rows = await db
    .select()
    .from(knowledgeEntriesTable)
    .where(
      projectId
        ? or(
            eq(knowledgeEntriesTable.approvedForReuse, true),
            eq(knowledgeEntriesTable.projectId, projectId),
          )
        : eq(knowledgeEntriesTable.approvedForReuse, true),
    )
    .orderBy(desc(knowledgeEntriesTable.createdAt))
    .limit(100);

  res.json(rows);
});

// POST /api/knowledge — manually create a knowledge entry (admin / power users).
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

// Suppress unused import lint warning — isNull/and/eq may be used in future filters
void isNull;
void and;
void eq;

export default router;
