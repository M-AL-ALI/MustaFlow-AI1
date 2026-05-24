/**
 * Task #546 — Agent Inbox & Chat History Search routes.
 *
 *   POST   /api/projects/:id/inbox                  Submit feedback
 *   GET    /api/projects/:id/inbox                  List inbox items (filter by status)
 *   PATCH  /api/projects/:id/inbox/:itemId          Update status (mark read / resolved)
 *   DELETE /api/projects/:id/inbox/:itemId          Delete
 *   GET    /api/projects/:id/messages/search?q=...  Full-text search chat history
 */
import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  agentInboxTable,
  chatMessagesTable,
  AGENT_INBOX_CATEGORIES,
  AGENT_INBOX_SEVERITIES,
  AGENT_INBOX_STATUSES,
  type AgentInboxCategory,
  type AgentInboxSeverity,
  type AgentInboxStatus,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Use the same canonical parser as requireProjectOwnership (parseInt) to avoid
// IDOR-style mismatches where e.g. "1e2" → 1 in the middleware but 100 here.
// Also require pure-digit IDs so "01" / "1abc" / "1e2" cannot smuggle a
// different numeric id past the ownership check.
function parseProjectId(raw: unknown): number | null {
  const s = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "";
  if (typeof s !== "string" || !/^[1-9]\d*$/.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

router.post("/projects/:id/inbox", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = parseProjectId(req.params.id);
  if (projectId === null) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  const body = (req.body ?? {}) as {
    category?: string;
    severity?: string;
    description?: string;
    screenshotUrl?: string | null;
  };
  const category = (
    AGENT_INBOX_CATEGORIES.includes(body.category as AgentInboxCategory) ? body.category : "bug"
  ) as AgentInboxCategory;
  const severity = (
    AGENT_INBOX_SEVERITIES.includes(body.severity as AgentInboxSeverity) ? body.severity : "medium"
  ) as AgentInboxSeverity;
  const description = (body.description ?? "").trim();
  if (description.length === 0 || description.length > 4000) {
    res.status(400).json({ error: "description must be 1-4000 chars" });
    return;
  }
  const screenshotUrl =
    typeof body.screenshotUrl === "string" && body.screenshotUrl.trim().length > 0
      ? body.screenshotUrl.trim().slice(0, 2048)
      : null;

  const [row] = await db
    .insert(agentInboxTable)
    .values({
      projectId,
      userId: req.userId ?? null,
      category,
      severity,
      description,
      screenshotUrl,
      status: "unread",
    })
    .returning();
  res.status(201).json(row);
});

router.get("/projects/:id/inbox", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = parseProjectId(req.params.id);
  if (projectId === null) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  const statusFilter = typeof req.query.status === "string" ? req.query.status : null;
  const where =
    statusFilter && AGENT_INBOX_STATUSES.includes(statusFilter as AgentInboxStatus)
      ? and(
          eq(agentInboxTable.projectId, projectId),
          eq(agentInboxTable.status, statusFilter as AgentInboxStatus),
        )
      : eq(agentInboxTable.projectId, projectId);
  const rows = await db
    .select()
    .from(agentInboxTable)
    .where(where)
    .orderBy(desc(agentInboxTable.createdAt))
    .limit(200);
  res.json({ items: rows });
});

router.patch(
  "/projects/:id/inbox/:itemId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = parseProjectId(req.params.id);
    const itemId = parseProjectId(req.params.itemId);
    if (projectId === null || itemId === null) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const body = (req.body ?? {}) as { status?: string };
    if (!AGENT_INBOX_STATUSES.includes(body.status as AgentInboxStatus)) {
      res.status(400).json({ error: "status must be unread|read|resolved" });
      return;
    }
    const status = body.status as AgentInboxStatus;
    const now = new Date();
    const [updated] = await db
      .update(agentInboxTable)
      .set({
        status,
        readAt: status !== "unread" ? now : null,
        resolvedAt: status === "resolved" ? now : null,
      })
      .where(and(eq(agentInboxTable.id, itemId), eq(agentInboxTable.projectId, projectId)))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Item not found" });
      return;
    }
    res.json(updated);
  },
);

router.delete(
  "/projects/:id/inbox/:itemId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = parseProjectId(req.params.id);
    const itemId = parseProjectId(req.params.itemId);
    if (projectId === null || itemId === null) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    await db
      .delete(agentInboxTable)
      .where(and(eq(agentInboxTable.id, itemId), eq(agentInboxTable.projectId, projectId)));
    res.json({ deleted: true });
  },
);

// ── Full-text search across chat messages for one project ────────────────────
router.get(
  "/projects/:id/messages/search",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = parseProjectId(req.params.id);
    if (projectId === null) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length === 0) {
      res.json({ query: q, results: [] });
      return;
    }
    if (q.length > 200) {
      res.status(400).json({ error: "query too long" });
      return;
    }
    const limit = Math.min(
      50,
      Math.max(1, Number(req.query.limit) > 0 ? Math.floor(Number(req.query.limit)) : 25),
    );
    try {
      const tsq = sql`plainto_tsquery('english', ${q})`;
      const rows = await db
        .select({
          id: chatMessagesTable.id,
          role: chatMessagesTable.role,
          content: chatMessagesTable.content,
          createdAt: chatMessagesTable.createdAt,
          rank: sql<number>`ts_rank(content_tsv, ${tsq})`,
          snippet: sql<string>`ts_headline('english', ${chatMessagesTable.content}, ${tsq}, 'MaxFragments=2,MinWords=3,MaxWords=18,StartSel=«,StopSel=»')`,
        })
        .from(chatMessagesTable)
        .where(sql`${chatMessagesTable.projectId} = ${projectId} AND content_tsv @@ ${tsq}`)
        .orderBy(sql`ts_rank(content_tsv, ${tsq}) DESC`)
        .limit(limit);
      res.json({ query: q, results: rows });
    } catch (err) {
      logger.error({ err, projectId, q }, "Full-text search failed");
      res.status(500).json({ error: "Search failed" });
    }
  },
);

export default router;
