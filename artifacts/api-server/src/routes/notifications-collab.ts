import { Router, type IRouter } from "express";
import { and, eq, desc, lt } from "drizzle-orm";
import { db, notificationsTable } from "@workspace/db";

const router: IRouter = Router();

// ── List notifications for the current user ───────────────────────────────────
router.get("/notifications", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 100);
  const unreadOnly = req.query.unread === "true";
  const cursor = req.query.cursor ? parseInt(String(req.query.cursor), 10) : undefined;

  const conditions = [eq(notificationsTable.recipientId, userId)];
  if (unreadOnly) conditions.push(eq(notificationsTable.read, false));
  if (cursor != null && Number.isFinite(cursor)) {
    conditions.push(lt(notificationsTable.id, cursor));
  }

  const rows = await db
    .select()
    .from(notificationsTable)
    .where(and(...conditions))
    .orderBy(desc(notificationsTable.createdAt))
    .limit(limit);

  // Also return unread count for the bell badge
  const unreadCount = await db
    .select({ id: notificationsTable.id })
    .from(notificationsTable)
    .where(and(eq(notificationsTable.recipientId, userId), eq(notificationsTable.read, false)));

  res.json({
    notifications: rows,
    unreadCount: unreadCount.length,
    nextCursor: rows.length === limit ? rows[rows.length - 1]?.id : null,
  });
});

// ── Mark one notification as read ─────────────────────────────────────────────
router.post("/notifications/:notifId/read", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const notifId = parseInt(req.params.notifId, 10);
  if (!Number.isFinite(notifId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  await db
    .update(notificationsTable)
    .set({ read: true, readAt: new Date() })
    .where(and(eq(notificationsTable.id, notifId), eq(notificationsTable.recipientId, userId)));

  res.json({ read: true });
});

// ── Mark all notifications as read ────────────────────────────────────────────
router.post("/notifications/read-all", async (req, res): Promise<void> => {
  const userId = req.userId!;

  await db
    .update(notificationsTable)
    .set({ read: true, readAt: new Date() })
    .where(and(eq(notificationsTable.recipientId, userId), eq(notificationsTable.read, false)));

  res.json({ done: true });
});

// ── Delete a notification ─────────────────────────────────────────────────────
router.delete("/notifications/:notifId", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const notifId = parseInt(req.params.notifId, 10);
  if (!Number.isFinite(notifId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  await db
    .delete(notificationsTable)
    .where(and(eq(notificationsTable.id, notifId), eq(notificationsTable.recipientId, userId)));

  res.json({ deleted: true });
});

export default router;
