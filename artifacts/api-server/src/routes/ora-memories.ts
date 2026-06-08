import { Router } from "express";
import { z } from "zod";
import { and, eq, desc, isNull, inArray, ne } from "drizzle-orm";
import {
  db,
  knowledgeEntriesTable,
  ORA_MEMORY_CATEGORIES,
  DEFAULT_ORA_MEMORY_CATEGORY,
} from "@workspace/db";
import { classifyOraMemoryCategory } from "../lib/ora-memory-category";
import { logger } from "../lib/logger";
import { findMemoriesToSupersede } from "../lib/public-ai/memory-consolidation";

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

const categoryEnum = z.enum(ORA_MEMORY_CATEGORIES);

/**
 * Coerce a stored `category` into a known Ora category. Legacy rows (and any
 * Builder default of "note") collapse to the default so the UI never shows an
 * unknown chip before the backfill runs.
 */
function normalizeCategory<T extends { category: string | null }>(
  row: T,
): Omit<T, "category"> & { category: (typeof ORA_MEMORY_CATEGORIES)[number] } {
  const parsed = categoryEnum.safeParse(row.category);
  return { ...row, category: parsed.success ? parsed.data : DEFAULT_ORA_MEMORY_CATEGORY };
}

// List the user's saved Ora memories.
router.get("/ora/memories", async (req, res) => {
  const userId = req.userId!;
  try {
    const rows = await db
      .select({
        id: knowledgeEntriesTable.id,
        title: knowledgeEntriesTable.title,
        content: knowledgeEntriesTable.content,
        category: knowledgeEntriesTable.category,
        enabled: knowledgeEntriesTable.enabled,
        supersededBy: knowledgeEntriesTable.supersededBy,
        sourceConversationId: knowledgeEntriesTable.sourceConversationId,
        createdAt: knowledgeEntriesTable.createdAt,
      })
      .from(knowledgeEntriesTable)
      .where(userScope(userId))
      .orderBy(desc(knowledgeEntriesTable.createdAt));
    res.json({ memories: rows.map(normalizeCategory) });
  } catch (err) {
    logger.error({ component: "ora-memories", err }, "Failed to list memories");
    res.status(500).json({ error: "Failed to load memories" });
  }
});

const createMemorySchema = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE),
  content: z.string().trim().max(MAX_CONTENT).optional(),
  category: categoryEnum.optional(),
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
  const title = parsed.data.title;
  const content = parsed.data.content ?? "";
  try {
    // Auto-categorize on save unless the caller picked one explicitly.
    const category =
      parsed.data.category ??
      classifyOraMemoryCategory(parsed.data.title, parsed.data.content ?? "");
    const [row] = await db
      .insert(knowledgeEntriesTable)
      .values({
        title,
        content,
        type: "note",
        category,
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
        category: knowledgeEntriesTable.category,
        enabled: knowledgeEntriesTable.enabled,
        supersededBy: knowledgeEntriesTable.supersededBy,
        sourceConversationId: knowledgeEntriesTable.sourceConversationId,
        createdAt: knowledgeEntriesTable.createdAt,
      });
    // Consolidation: when the new fact overlaps earlier active memories (a
    // contradicting update like "dark mode" → "light mode"), supersede those
    // earlier entries so only the current fact is injected into Ora's context.
    // Non-destructive: superseded rows are kept (still listed in the Memory
    // Center) and just disabled + tagged with this new row's id. Best-effort —
    // a failure here never fails the save.
    const supersededIds = await consolidateOverlappingMemories(userId, row.id, title, content);

    res.status(201).json({ memory: normalizeCategory(row), supersededIds });
  } catch (err) {
    logger.error({ component: "ora-memories", err }, "Failed to create memory");
    res.status(500).json({ error: "Failed to create memory" });
  }
});

/**
 * Find the user's existing ACTIVE Ora memories that the just-saved memory
 * (`newId`) supersedes, and disable + tag them. Returns the superseded ids.
 * Conservative: only high-overlap matches are touched (see memory-consolidation
 * for the rule). Never throws — consolidation is best-effort.
 */
async function consolidateOverlappingMemories(
  userId: string,
  newId: number,
  title: string,
  content: string,
): Promise<number[]> {
  try {
    // Only compare against active rows: enabled, not archived, not already
    // superseded, and excluding the new row itself.
    const candidates = await db
      .select({
        id: knowledgeEntriesTable.id,
        title: knowledgeEntriesTable.title,
        content: knowledgeEntriesTable.content,
      })
      .from(knowledgeEntriesTable)
      .where(
        and(
          userScope(userId),
          eq(knowledgeEntriesTable.enabled, true),
          isNull(knowledgeEntriesTable.supersededBy),
          ne(knowledgeEntriesTable.id, newId),
        ),
      );

    const toSupersede = findMemoriesToSupersede({ title, content }, candidates);
    if (toSupersede.length === 0) return [];

    await db
      .update(knowledgeEntriesTable)
      .set({ supersededBy: newId, enabled: false })
      .where(and(inArray(knowledgeEntriesTable.id, toSupersede), userScope(userId)));

    return toSupersede;
  } catch (err) {
    logger.warn(
      { component: "ora-memories", err, newId },
      "Memory consolidation failed (non-fatal)",
    );
    return [];
  }
}

const patchMemorySchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE).optional(),
    content: z.string().max(MAX_CONTENT).optional(),
    enabled: z.boolean().optional(),
    category: categoryEnum.optional(),
  })
  .refine(
    (d) =>
      d.title !== undefined ||
      d.content !== undefined ||
      d.enabled !== undefined ||
      d.category !== undefined,
    {
      message: "No fields to update",
    },
  );

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
  if (parsed.data.category !== undefined) updates.category = parsed.data.category;

  try {
    const [row] = await db
      .update(knowledgeEntriesTable)
      .set(updates)
      .where(and(eq(knowledgeEntriesTable.id, id), userScope(userId)))
      .returning({
        id: knowledgeEntriesTable.id,
        title: knowledgeEntriesTable.title,
        content: knowledgeEntriesTable.content,
        category: knowledgeEntriesTable.category,
        enabled: knowledgeEntriesTable.enabled,
        supersededBy: knowledgeEntriesTable.supersededBy,
        sourceConversationId: knowledgeEntriesTable.sourceConversationId,
        createdAt: knowledgeEntriesTable.createdAt,
      });
    if (!row) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.json({ memory: normalizeCategory(row) });
  } catch (err) {
    logger.error({ component: "ora-memories", err }, "Failed to update memory");
    res.status(500).json({ error: "Failed to update memory" });
  }
});

// Restore a superseded memory: clear its superseded marker and re-enable it so
// Ora references it again. The user's explicit undo of a consolidation — both
// the restored fact and whatever superseded it stay active afterwards (their
// choice). No-op for memories that were not superseded.
router.post("/ora/memories/:id/restore", async (req, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid memory id" });
    return;
  }
  try {
    const [row] = await db
      .update(knowledgeEntriesTable)
      .set({ supersededBy: null, enabled: true })
      .where(and(eq(knowledgeEntriesTable.id, id), userScope(userId)))
      .returning({
        id: knowledgeEntriesTable.id,
        title: knowledgeEntriesTable.title,
        content: knowledgeEntriesTable.content,
        enabled: knowledgeEntriesTable.enabled,
        supersededBy: knowledgeEntriesTable.supersededBy,
        sourceConversationId: knowledgeEntriesTable.sourceConversationId,
        createdAt: knowledgeEntriesTable.createdAt,
      });
    if (!row) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.json({ memory: row });
  } catch (err) {
    logger.error({ component: "ora-memories", err }, "Failed to restore memory");
    res.status(500).json({ error: "Failed to restore memory" });
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
