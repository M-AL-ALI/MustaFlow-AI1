import { Router } from "express";
import { z } from "zod";
import { and, eq, desc, isNull } from "drizzle-orm";
import { db, knowledgeEntriesTable } from "@workspace/db";
import { logger } from "../lib/logger";

const router = Router();

/* ─── Ora saved memories ──────────────────────────────────────────────────────
 *
 * ISOLATION: Ora memories are stored in `knowledge_entries` with scope="user"
 * AND origin="ora". Every query here filters by all three (userId, scope=user,
 * origin=ora) so the Memory Center can never read, edit, or delete AI Builder
 * Knowledge Vault entries — including Builder-generated user-scope style memories
 * and brand profiles (origin="builder"). Mirrors the isolation rule in
 * buildMemoryContext (routes/public-ai/chat.ts).
 */

const userScope = (userId: string) =>
  and(
    eq(knowledgeEntriesTable.userId, userId),
    eq(knowledgeEntriesTable.scope, "user"),
    eq(knowledgeEntriesTable.origin, "ora"),
    isNull(knowledgeEntriesTable.archivedAt),
  );

const MAX_TITLE = 200;
const MAX_CONTENT = 4000;

// List the user's saved Ora memories.
router.get("/ora/memories", async (req, res) => {
  const userId = req.userId!;
  try {
    const rows = await db
      .select({
        id: knowledgeEntriesTable.id,
        title: knowledgeEntriesTable.title,
        content: knowledgeEntriesTable.content,
        enabled: knowledgeEntriesTable.enabled,
        sourceConversationId: knowledgeEntriesTable.sourceConversationId,
        createdAt: knowledgeEntriesTable.createdAt,
      })
      .from(knowledgeEntriesTable)
      .where(userScope(userId))
      .orderBy(desc(knowledgeEntriesTable.createdAt));
    res.json({ memories: rows });
  } catch (err) {
    logger.error({ component: "ora-memories", err }, "Failed to list memories");
    res.status(500).json({ error: "Failed to load memories" });
  }
});

const createMemorySchema = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE),
  content: z.string().trim().max(MAX_CONTENT).optional(),
});

// Create a new Ora memory (user-approved save). Always tagged origin="ora",
// scope="user", type="note" so it is isolated from the AI Builder Knowledge Vault.
router.post("/ora/memories", async (req, res) => {
  const userId = req.userId!;
  const parsed = createMemorySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  try {
    const [row] = await db
      .insert(knowledgeEntriesTable)
      .values({
        title: parsed.data.title,
        content: parsed.data.content ?? "",
        type: "note",
        category: "note",
        severity: "info",
        scope: "user",
        origin: "ora",
        userId,
        projectId: null,
        enabled: true,
        approvedForReuse: false,
      })
      .returning({
        id: knowledgeEntriesTable.id,
        title: knowledgeEntriesTable.title,
        content: knowledgeEntriesTable.content,
        enabled: knowledgeEntriesTable.enabled,
        sourceConversationId: knowledgeEntriesTable.sourceConversationId,
        createdAt: knowledgeEntriesTable.createdAt,
      });
    res.status(201).json({ memory: row });
  } catch (err) {
    logger.error({ component: "ora-memories", err }, "Failed to create memory");
    res.status(500).json({ error: "Failed to create memory" });
  }
});

const patchMemorySchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE).optional(),
    content: z.string().max(MAX_CONTENT).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((d) => d.title !== undefined || d.content !== undefined || d.enabled !== undefined, {
    message: "No fields to update",
  });

// Edit a memory's text or toggle whether Ora may reference it.
router.patch("/ora/memories/:id", async (req, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid memory id" });
    return;
  }
  const parsed = patchMemorySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const updates: Partial<typeof knowledgeEntriesTable.$inferInsert> = {};
  if (parsed.data.title !== undefined) updates.title = parsed.data.title;
  if (parsed.data.content !== undefined) updates.content = parsed.data.content;
  if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;

  try {
    const [row] = await db
      .update(knowledgeEntriesTable)
      .set(updates)
      .where(and(eq(knowledgeEntriesTable.id, id), userScope(userId)))
      .returning({
        id: knowledgeEntriesTable.id,
        title: knowledgeEntriesTable.title,
        content: knowledgeEntriesTable.content,
        enabled: knowledgeEntriesTable.enabled,
        sourceConversationId: knowledgeEntriesTable.sourceConversationId,
        createdAt: knowledgeEntriesTable.createdAt,
      });
    if (!row) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.json({ memory: row });
  } catch (err) {
    logger.error({ component: "ora-memories", err }, "Failed to update memory");
    res.status(500).json({ error: "Failed to update memory" });
  }
});

// Soft-delete a single memory (archive). Order matters: this exact-id route is
// registered before the collection clear-all below.
router.delete("/ora/memories/:id", async (req, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid memory id" });
    return;
  }
  try {
    await db
      .update(knowledgeEntriesTable)
      .set({ archivedAt: new Date() })
      .where(and(eq(knowledgeEntriesTable.id, id), userScope(userId)));
    res.json({ ok: true });
  } catch (err) {
    logger.error({ component: "ora-memories", err }, "Failed to delete memory");
    res.status(500).json({ error: "Failed to delete memory" });
  }
});

// Clear ALL of the user's saved Ora memories (Data Controls). Archives only
// user-scope rows — Builder project knowledge is never touched.
router.delete("/ora/memories", async (req, res) => {
  const userId = req.userId!;
  try {
    await db.update(knowledgeEntriesTable).set({ archivedAt: new Date() }).where(userScope(userId));
    res.json({ ok: true });
  } catch (err) {
    logger.error({ component: "ora-memories", err }, "Failed to clear memories");
    res.status(500).json({ error: "Failed to clear memories" });
  }
});

export default router;
