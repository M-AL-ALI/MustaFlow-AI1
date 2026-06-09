import { Router } from "express";
import { z } from "zod";
import { and, eq, desc, isNull, inArray, ne, sql } from "drizzle-orm";
import {
  db,
  knowledgeEntriesTable,
  oraProjectsTable,
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
 *
 * THREE MEMORY TIERS (all origin="ora", all isolated from Builder):
 *   - user-level   : ora_project_id IS NULL — applies to every Ora chat.
 *   - ora-project  : ora_project_id = <ora_projects.id> — persists across every
 *                    conversation in that project. Uses the dedicated
 *                    `oraProjectId` column, NOT Builder's `projectId`.
 */

// Matches every Ora memory the user owns (both user-level and project-scoped).
const baseScope = (userId: string) =>
  and(
    eq(knowledgeEntriesTable.userId, userId),
    eq(knowledgeEntriesTable.scope, "user"),
    eq(knowledgeEntriesTable.origin, "ora"),
    isNull(knowledgeEntriesTable.archivedAt),
  );

const memoryColumns = {
  id: knowledgeEntriesTable.id,
  title: knowledgeEntriesTable.title,
  content: knowledgeEntriesTable.content,
  enabled: knowledgeEntriesTable.enabled,
  category: knowledgeEntriesTable.category,
  oraProjectId: knowledgeEntriesTable.oraProjectId,
  supersededBy: knowledgeEntriesTable.supersededBy,
  sourceConversationId: knowledgeEntriesTable.sourceConversationId,
  createdAt: knowledgeEntriesTable.createdAt,
};

const MAX_TITLE = 200;
const MAX_CONTENT = 4000;

/**
 * Maximum number of saved Ora memories per user (across all tiers — user-level
 * plus every project). Configurable via ORA_MEMORY_MAX; defaults to 200. Once a
 * user is at the cap, new saves are rejected with 409 until they delete some.
 */
const ORA_MEMORY_LIMIT = (() => {
  const parsed = parseInt(process.env.ORA_MEMORY_MAX ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
})();

/** Count the user's active (non-archived) Ora memories across all tiers. */
async function countOraMemories(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(knowledgeEntriesTable)
    .where(baseScope(userId));
  return row?.count ?? 0;
}

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

// Verify the caller owns the (non-archived) Ora project. Returns true when the
// project id is valid and owned, false otherwise.
async function ownsOraProject(userId: string, oraProjectId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: oraProjectsTable.id })
    .from(oraProjectsTable)
    .where(
      and(
        eq(oraProjectsTable.id, oraProjectId),
        eq(oraProjectsTable.userId, userId),
        isNull(oraProjectsTable.archivedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

// List the user's saved Ora memories.
//   ?oraProjectId=<id> — list that project's memories.
//   (omitted)          — list user-level memories (ora_project_id IS NULL).
router.get("/ora/memories", async (req, res) => {
  const userId = req.userId!;
  const projectIdParam = req.query.oraProjectId;
  const oraProjectId =
    typeof projectIdParam === "string" && /^\d+$/.test(projectIdParam)
      ? parseInt(projectIdParam, 10)
      : null;
  try {
    const rows = await db
      .select(memoryColumns)
      .from(knowledgeEntriesTable)
      .where(
        and(
          baseScope(userId),
          oraProjectId !== null
            ? eq(knowledgeEntriesTable.oraProjectId, oraProjectId)
            : isNull(knowledgeEntriesTable.oraProjectId),
        ),
      )
      .orderBy(desc(knowledgeEntriesTable.createdAt));
    res.json({ memories: rows.map(normalizeCategory) });
  } catch (err) {
    logger.error({ component: "ora-memories", err }, "Failed to list memories");
    res.status(500).json({ error: "Failed to load memories" });
  }
});

// Report how many memories the user has saved against their cap, so the Memory
// Center can render a capacity meter and warn as the user approaches the limit.
router.get("/ora/memories/usage", async (req, res) => {
  const userId = req.userId!;
  try {
    const count = await countOraMemories(userId);
    res.json({ count, limit: ORA_MEMORY_LIMIT });
  } catch (err) {
    logger.error({ component: "ora-memories", err }, "Failed to load memory usage");
    res.status(500).json({ error: "Failed to load memory usage" });
  }
});

const createMemorySchema = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE),
  content: z.string().trim().max(MAX_CONTENT).optional(),
  category: categoryEnum.optional(),
  // When set, the memory is anchored to an Ora project and persists across every
  // conversation in that project. Validated against ownership before insert.
  oraProjectId: z.number().int().positive().nullable().optional(),
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
  const oraProjectId = parsed.data.oraProjectId ?? null;
  if (oraProjectId !== null && !(await ownsOraProject(userId, oraProjectId))) {
    res.status(404).json({ error: "Ora project not found" });
    return;
  }
  try {
    // Auto-categorize on save unless the caller picked one explicitly.
    const category =
      parsed.data.category ??
      classifyOraMemoryCategory(parsed.data.title, parsed.data.content ?? "");

    // Capacity guard + insert run atomically under a per-user advisory lock so
    // concurrent saves can't both pass the count check and overshoot the cap.
    // A null result means the user is at their memory limit; the client surfaces
    // it as a clear "memory full" message pointing at the Memory Center.
    const row = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId})::bigint)`);
      const [c] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(knowledgeEntriesTable)
        .where(baseScope(userId));
      if ((c?.count ?? 0) >= ORA_MEMORY_LIMIT) return null;
      const [inserted] = await tx
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
          oraProjectId,
          enabled: true,
          approvedForReuse: false,
        })
        .returning(memoryColumns);
      return inserted;
    });

    if (!row) {
      res.status(409).json({
        error: `You've reached your saved-memory limit (${ORA_MEMORY_LIMIT}). Delete some memories to save new ones.`,
        code: "memory_full",
        limit: ORA_MEMORY_LIMIT,
      });
      return;
    }

    // Consolidation: when the new fact overlaps earlier active memories (a
    // contradicting update like "dark mode" → "light mode"), supersede those
    // earlier entries so only the current fact is injected into Ora's context.
    // Non-destructive: superseded rows are kept (still listed in the Memory
    // Center) and just disabled + tagged with this new row's id. Best-effort —
    // a failure here never fails the save. Scoped to the same memory tier
    // (project vs user-level) so a project memory never supersedes a user-level
    // fact (or one in a different project), and vice versa.
    const superseded = await consolidateOverlappingMemories(
      userId,
      row.id,
      title,
      content,
      oraProjectId,
    );

    // `supersededIds` kept for backward compatibility; `superseded` carries the
    // titles so the Ora chat can name exactly what was replaced inline.
    res.status(201).json({
      memory: normalizeCategory(row),
      supersededIds: superseded.map((s) => s.id),
      superseded,
    });
  } catch (err) {
    logger.error({ component: "ora-memories", err }, "Failed to create memory");
    res.status(500).json({ error: "Failed to create memory" });
  }
});

/**
 * Find the user's existing ACTIVE Ora memories that the just-saved memory
 * (`newId`) supersedes, and disable + tag them. Returns the superseded entries
 * (id + title) so the caller can tell the user exactly what was replaced.
 * Conservative: only high-overlap matches are touched (see memory-consolidation
 * for the rule). Never throws — consolidation is best-effort.
 */
async function consolidateOverlappingMemories(
  userId: string,
  newId: number,
  title: string,
  content: string,
  oraProjectId: number | null,
): Promise<Array<{ id: number; title: string }>> {
  try {
    // Only compare against active rows in the SAME tier: enabled, not archived,
    // not already superseded, matching project vs user-level scope, and
    // excluding the new row itself. Tier-scoping keeps a project memory from
    // superseding a user-level fact (or one in a different project).
    const sameTier =
      oraProjectId !== null
        ? eq(knowledgeEntriesTable.oraProjectId, oraProjectId)
        : isNull(knowledgeEntriesTable.oraProjectId);
    const candidates = await db
      .select({
        id: knowledgeEntriesTable.id,
        title: knowledgeEntriesTable.title,
        content: knowledgeEntriesTable.content,
      })
      .from(knowledgeEntriesTable)
      .where(
        and(
          baseScope(userId),
          sameTier,
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
      .where(and(inArray(knowledgeEntriesTable.id, toSupersede), baseScope(userId)));

    const toSupersedeSet = new Set(toSupersede);
    return candidates
      .filter((c) => toSupersedeSet.has(c.id))
      .map((c) => ({ id: c.id, title: c.title }));
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

// Edit a memory's text or toggle whether Ora may reference it. Works for both
// user-level and project-scoped memories (scoped by id + owner + origin="ora").
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
      .where(and(eq(knowledgeEntriesTable.id, id), baseScope(userId)))
      .returning(memoryColumns);
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
      .where(and(eq(knowledgeEntriesTable.id, id), baseScope(userId)))
      .returning(memoryColumns);
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
      .where(and(eq(knowledgeEntriesTable.id, id), baseScope(userId)));
    res.json({ ok: true });
  } catch (err) {
    logger.error({ component: "ora-memories", err }, "Failed to delete memory");
    res.status(500).json({ error: "Failed to delete memory" });
  }
});

// Clear ALL of the user's saved Ora memories (Data Controls). Archives every
// origin="ora" user row (both user-level and project-scoped) — Builder project
// knowledge is never touched.
router.delete("/ora/memories", async (req, res) => {
  const userId = req.userId!;
  try {
    await db.update(knowledgeEntriesTable).set({ archivedAt: new Date() }).where(baseScope(userId));
    res.json({ ok: true });
  } catch (err) {
    logger.error({ component: "ora-memories", err }, "Failed to clear memories");
    res.status(500).json({ error: "Failed to clear memories" });
  }
});

export default router;
