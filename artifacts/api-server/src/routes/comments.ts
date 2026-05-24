import { Router, type IRouter } from "express";
import { and, eq, isNull, desc, asc } from "drizzle-orm";
import { db, projectCommentsTable, projectsTable, notificationsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { z } from "zod";

// Express v5 types params as string | string[] — extract the scalar value.
const pstr = (v: string | string[]): string => (Array.isArray(v) ? (v[0] ?? "") : v);

const router: IRouter = Router();

// ── List comments for a project ───────────────────────────────────────────────
// Returns only top-level (non-deleted) comments; replies are nested in replies[].
router.get(
  "/projects/:id/comments",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = parseInt(pstr(req.params.id), 10);
    const filePath = typeof req.query.filePath === "string" ? req.query.filePath : undefined;

    const conditions = [
      eq(projectCommentsTable.projectId, projectId),
      isNull(projectCommentsTable.deletedAt),
    ];
    if (filePath) {
      conditions.push(eq(projectCommentsTable.filePath, filePath));
    }

    const rows = await db
      .select()
      .from(projectCommentsTable)
      .where(and(...conditions))
      .orderBy(asc(projectCommentsTable.createdAt));

    // Nest replies under their parent
    const topLevel: typeof rows = [];
    const replyMap = new Map<number, typeof rows>();
    for (const row of rows) {
      if (row.parentId == null) {
        topLevel.push(row);
      } else {
        if (!replyMap.has(row.parentId)) replyMap.set(row.parentId, []);
        replyMap.get(row.parentId)!.push(row);
      }
    }

    const threaded = topLevel.map((c) => ({
      ...c,
      replies: replyMap.get(c.id) ?? [],
    }));

    res.json(threaded);
  },
);

// ── Create comment ────────────────────────────────────────────────────────────
const CreateCommentBody = z.object({
  body: z.string().min(1).max(10000),
  parentId: z.number().int().positive().optional(),
  filePath: z.string().max(500).optional(),
  lineStart: z.number().int().min(1).optional(),
  lineEnd: z.number().int().min(1).optional(),
  buildResultId: z.number().int().positive().optional(),
  authorName: z.string().max(200).optional(),
  authorAvatar: z.string().url().max(500).optional(),
});

router.post(
  "/projects/:id/comments",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = parseInt(pstr(req.params.id), 10);
    const userId = req.userId!;

    const parsed = CreateCommentBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

    // Validate parent belongs to same project
    if (parsed.data.parentId != null) {
      const [parent] = await db
        .select({ id: projectCommentsTable.id, projectId: projectCommentsTable.projectId })
        .from(projectCommentsTable)
        .where(eq(projectCommentsTable.id, parsed.data.parentId));
      if (!parent || parent.projectId !== projectId) {
        res.status(400).json({ error: "Parent comment not found in this project" }); return;
      }
    }

    const [comment] = await db
      .insert(projectCommentsTable)
      .values({
        projectId,
        authorId: userId,
        authorName: parsed.data.authorName ?? null,
        authorAvatar: parsed.data.authorAvatar ?? null,
        parentId: parsed.data.parentId ?? null,
        filePath: parsed.data.filePath ?? null,
        lineStart: parsed.data.lineStart ?? null,
        lineEnd: parsed.data.lineEnd ?? null,
        buildResultId: parsed.data.buildResultId ?? null,
        body: parsed.data.body,
      })
      .returning();

    if (!comment) { res.status(500).json({ error: "Failed to create comment" }); return; }

    // Parse @mentions and create notifications
    const mentions = [...parsed.data.body.matchAll(/@([a-zA-Z0-9_.-]+)/g)].map((m) => m[1]);
    if (mentions.length > 0) {
      // Get project members from org to resolve mentions to user IDs
      // For now, log the mentions — full mention resolution requires a user directory API
      // which is Clerk-dependent and can be wired up as a follow-up.
    }

    // Notify parent comment author of the reply
    if (parsed.data.parentId != null) {
      const [parent] = await db
        .select({ authorId: projectCommentsTable.authorId })
        .from(projectCommentsTable)
        .where(eq(projectCommentsTable.id, parsed.data.parentId));
      if (parent && parent.authorId !== userId) {
        await db.insert(notificationsTable).values({
          recipientId: parent.authorId,
          type: "comment_reply",
          title: "New reply to your comment",
          body: parsed.data.body.slice(0, 200),
          actorId: userId,
          actorName: parsed.data.authorName ?? null,
          resourceType: "comment",
          resourceId: String(comment.id),
          projectId,
          metadata: { commentId: comment.id, parentId: parsed.data.parentId },
        });
      }
    }

    res.status(201).json({ ...comment, replies: [] });
  },
);

// ── Update comment (edit body) ────────────────────────────────────────────────
const UpdateCommentBody = z.object({
  body: z.string().min(1).max(10000),
});

router.patch(
  "/projects/:id/comments/:commentId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = parseInt(pstr(req.params.id), 10);
    const commentId = parseInt(pstr(req.params.commentId), 10);
    const userId = req.userId!;

    if (!Number.isFinite(commentId)) { res.status(400).json({ error: "Invalid comment id" }); return; }

    const parsed = UpdateCommentBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

    const [existing] = await db
      .select()
      .from(projectCommentsTable)
      .where(
        and(
          eq(projectCommentsTable.id, commentId),
          eq(projectCommentsTable.projectId, projectId),
          isNull(projectCommentsTable.deletedAt),
        ),
      );

    if (!existing) { res.status(404).json({ error: "Comment not found" }); return; }
    if (existing.authorId !== userId) { res.status(403).json({ error: "Cannot edit another user's comment" }); return; }

    const [updated] = await db
      .update(projectCommentsTable)
      .set({ body: parsed.data.body, editedAt: new Date(), updatedAt: new Date() })
      .where(eq(projectCommentsTable.id, commentId))
      .returning();

    res.json(updated);
  },
);

// ── Resolve / unresolve comment ───────────────────────────────────────────────
router.post(
  "/projects/:id/comments/:commentId/resolve",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = parseInt(pstr(req.params.id), 10);
    const commentId = parseInt(pstr(req.params.commentId), 10);
    const userId = req.userId!;
    const resolved: boolean = req.body?.resolved !== false;

    if (!Number.isFinite(commentId)) { res.status(400).json({ error: "Invalid comment id" }); return; }

    const [existing] = await db
      .select()
      .from(projectCommentsTable)
      .where(
        and(
          eq(projectCommentsTable.id, commentId),
          eq(projectCommentsTable.projectId, projectId),
          isNull(projectCommentsTable.deletedAt),
        ),
      );

    if (!existing) { res.status(404).json({ error: "Comment not found" }); return; }

    const [updated] = await db
      .update(projectCommentsTable)
      .set({
        resolved,
        resolvedByUserId: resolved ? userId : null,
        resolvedAt: resolved ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(projectCommentsTable.id, commentId))
      .returning();

    res.json(updated);
  },
);

// ── Delete comment (soft) ─────────────────────────────────────────────────────
router.delete(
  "/projects/:id/comments/:commentId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = parseInt(pstr(req.params.id), 10);
    const commentId = parseInt(pstr(req.params.commentId), 10);
    const userId = req.userId!;

    if (!Number.isFinite(commentId)) { res.status(400).json({ error: "Invalid comment id" }); return; }

    const [existing] = await db
      .select()
      .from(projectCommentsTable)
      .where(
        and(
          eq(projectCommentsTable.id, commentId),
          eq(projectCommentsTable.projectId, projectId),
          isNull(projectCommentsTable.deletedAt),
        ),
      );

    if (!existing) { res.status(404).json({ error: "Comment not found" }); return; }
    if (existing.authorId !== userId) {
      // Project ownership already verified; allow project owners to delete any comment
      const [project] = await db
        .select({ ownerId: projectsTable.ownerId })
        .from(projectsTable)
        .where(eq(projectsTable.id, projectId));
      if (project?.ownerId !== userId) {
        res.status(403).json({ error: "Cannot delete another user's comment" }); return;
      }
    }

    await db
      .update(projectCommentsTable)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(projectCommentsTable.id, commentId));

    res.json({ deleted: true });
  },
);

export default router;
