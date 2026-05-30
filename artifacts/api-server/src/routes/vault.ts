import { Router, type IRouter } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, vaultEntriesTable, vaultVersionsTable } from "@workspace/db";
import { z } from "zod";
import { logger } from "../lib/logger";
import { detectSensitiveContent, sanitizeText } from "../lib/vault-sanitizer";

const router: IRouter = Router();

// ── Zod schemas ───────────────────────────────────────────────────────────────
const createVaultSchema = z.object({
  title: z.string().trim().min(1).max(500),
  category: z
    .enum([
      "REPORT",
      "INVESTIGATION",
      "CORRECTIVE_ACTION",
      "LESSON_LEARNED",
      "BEST_PRACTICE",
      "PROJECT",
      "SOP",
      "STANDARD",
      "AUDIT",
      "KPI",
      "RISK",
      "OTHER",
    ])
    .default("OTHER"),
  subcategory: z.string().trim().max(200).optional(),
  summary: z.string().trim().min(1).max(2000),
  content: z.string().trim().min(1).max(50000),
  tags: z.array(z.string().trim().max(100)).max(30).default([]),
  department: z.string().trim().max(200).optional(),
  sourceType: z
    .enum([
      "ORA_REPORT",
      "DATASET_ANALYSIS",
      "DOCUMENT_ANALYSIS",
      "IMAGE_ANALYSIS",
      "VOICE_TRANSCRIPT",
      "USER_CREATED",
      "MANUAL_ENTRY",
      "IMPORT",
      "OTHER",
    ])
    .default("USER_CREATED"),
  sourceReference: z.string().trim().max(500).optional(),
  confidenceScore: z.number().int().min(0).max(100).optional(),
  changeSummary: z.string().trim().max(500).optional(),
});

const updateVaultSchema = createVaultSchema.partial().extend({
  status: z.enum(["draft", "approved", "archived"]).optional(),
  approved: z.boolean().optional(),
  changeSummary: z.string().trim().max(500).optional(),
});

// ── POST /api/vault — create entry ────────────────────────────────────────────
router.post("/vault", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const parsed = createVaultSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", detail: parsed.error.flatten() });
    return;
  }

  const body = parsed.data;

  const contentIssue = detectSensitiveContent(body.content + " " + body.summary);
  if (contentIssue) {
    res.status(422).json({
      error: "Sensitive content detected",
      detail: contentIssue + ". Please remove credentials, tokens, or secrets before saving.",
    });
    return;
  }

  const safeContent = sanitizeText(body.content);
  const safeSummary = sanitizeText(body.summary);

  const [entry] = await db
    .insert(vaultEntriesTable)
    .values({
      userId,
      title: body.title,
      category: body.category,
      subcategory: body.subcategory ?? null,
      summary: safeSummary,
      content: safeContent,
      tags: body.tags,
      department: body.department ?? null,
      sourceType: body.sourceType,
      sourceReference: body.sourceReference ?? null,
      confidenceScore: body.confidenceScore ?? null,
      status: "draft",
      version: 1,
      approved: false,
    })
    .returning();

  await db.insert(vaultVersionsTable).values({
    entryId: entry.id,
    version: 1,
    title: entry.title,
    summary: entry.summary,
    content: entry.content,
    tags: entry.tags,
    department: entry.department,
    editedBy: userId,
    changeSummary: body.changeSummary ?? "Initial save",
  });

  logger.info({ entryId: entry.id, category: entry.category }, "vault: entry created");
  res.status(201).json(entry);
});

// ── GET /api/vault — list entries ─────────────────────────────────────────────
router.get("/vault", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const q = typeof req.query.q === "string" ? req.query.q.trim() : null;
  const category = typeof req.query.category === "string" ? req.query.category : null;
  const department = typeof req.query.department === "string" ? req.query.department : null;
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const includeArchived = req.query.archived === "true";
  const limit = Math.min(
    200,
    typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) || 50 : 50,
  );
  const offset = typeof req.query.offset === "string" ? parseInt(req.query.offset, 10) || 0 : 0;

  const conditions = [eq(vaultEntriesTable.userId, userId)];

  if (!includeArchived) {
    conditions.push(isNull(vaultEntriesTable.archivedAt));
  }
  if (category) {
    conditions.push(eq(vaultEntriesTable.category, category));
  }
  if (department) {
    conditions.push(eq(vaultEntriesTable.department, department));
  }
  if (status) {
    conditions.push(eq(vaultEntriesTable.status, status));
  }
  if (q) {
    // Functional GIN index: to_tsvector('pg_catalog.english'::regconfig, title || summary)
    // Matches vault_entries_search_idx created in migrate-vault-phase81.
    conditions.push(
      sql`to_tsvector('pg_catalog.english'::regconfig, coalesce(${vaultEntriesTable.title}, '') || ' ' || coalesce(${vaultEntriesTable.summary}, '')) @@ plainto_tsquery('pg_catalog.english'::regconfig, ${q})` as ReturnType<
        typeof eq
      >,
    );
  }

  const rows = await db
    .select()
    .from(vaultEntriesTable)
    .where(and(...conditions))
    .orderBy(desc(vaultEntriesTable.updatedAt))
    .limit(limit)
    .offset(offset);

  const total = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(vaultEntriesTable)
    .where(and(...conditions));

  res.json({ entries: rows, total: total[0]?.count ?? 0 });
});

// ── GET /api/vault/:id — get single entry ─────────────────────────────────────
router.get("/vault/:id", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const entryId = parseInt(req.params.id, 10);
  if (!Number.isFinite(entryId)) {
    res.status(400).json({ error: "Invalid entry id" });
    return;
  }

  const [entry] = await db
    .select()
    .from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.id, entryId), eq(vaultEntriesTable.userId, userId)));

  if (!entry) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }

  res.json(entry);
});

// ── PATCH /api/vault/:id — update entry (bumps version) ──────────────────────
router.patch("/vault/:id", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const entryId = parseInt(req.params.id, 10);
  if (!Number.isFinite(entryId)) {
    res.status(400).json({ error: "Invalid entry id" });
    return;
  }

  const [existing] = await db
    .select()
    .from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.id, entryId), eq(vaultEntriesTable.userId, userId)));

  if (!existing) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }

  if (existing.archivedAt) {
    res.status(409).json({ error: "Cannot edit an archived entry. Restore it first." });
    return;
  }

  const parsed = updateVaultSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", detail: parsed.error.flatten() });
    return;
  }

  const body = parsed.data;

  if (body.content || body.summary) {
    const combined = (body.content ?? "") + " " + (body.summary ?? "");
    const issue = detectSensitiveContent(combined);
    if (issue) {
      res.status(422).json({
        error: "Sensitive content detected",
        detail: issue + ". Please remove credentials, tokens, or secrets before saving.",
      });
      return;
    }
  }

  const newVersion = existing.version + 1;
  const updates: Partial<typeof vaultEntriesTable.$inferInsert> = {
    version: newVersion,
    updatedBy: userId,
    updatedAt: new Date(),
  };

  if (body.title !== undefined) updates.title = body.title;
  if (body.category !== undefined) updates.category = body.category;
  if (body.subcategory !== undefined) updates.subcategory = body.subcategory;
  if (body.summary !== undefined) updates.summary = sanitizeText(body.summary);
  if (body.content !== undefined) updates.content = sanitizeText(body.content);
  if (body.tags !== undefined) updates.tags = body.tags;
  if (body.department !== undefined) updates.department = body.department;
  if (body.sourceType !== undefined) updates.sourceType = body.sourceType;
  if (body.sourceReference !== undefined) updates.sourceReference = body.sourceReference;
  if (body.confidenceScore !== undefined) updates.confidenceScore = body.confidenceScore;
  if (body.status !== undefined) updates.status = body.status;
  if (body.approved !== undefined) updates.approved = body.approved;

  const [updated] = await db
    .update(vaultEntriesTable)
    .set(updates)
    .where(and(eq(vaultEntriesTable.id, entryId), eq(vaultEntriesTable.userId, userId)))
    .returning();

  await db.insert(vaultVersionsTable).values({
    entryId,
    version: newVersion,
    title: updated.title,
    summary: updated.summary,
    content: updated.content,
    tags: updated.tags,
    department: updated.department,
    editedBy: userId,
    changeSummary: body.changeSummary ?? null,
  });

  logger.info({ entryId, version: newVersion }, "vault: entry updated");
  res.json(updated);
});

// ── POST /api/vault/:id/archive ───────────────────────────────────────────────
router.post("/vault/:id/archive", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const entryId = parseInt(req.params.id, 10);
  if (!Number.isFinite(entryId)) {
    res.status(400).json({ error: "Invalid entry id" });
    return;
  }

  const [updated] = await db
    .update(vaultEntriesTable)
    .set({ archivedAt: new Date(), status: "archived", updatedAt: new Date(), updatedBy: userId })
    .where(
      and(
        eq(vaultEntriesTable.id, entryId),
        eq(vaultEntriesTable.userId, userId),
        isNull(vaultEntriesTable.archivedAt),
      ),
    )
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Entry not found or already archived" });
    return;
  }

  res.json(updated);
});

// ── POST /api/vault/:id/restore ───────────────────────────────────────────────
router.post("/vault/:id/restore", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const entryId = parseInt(req.params.id, 10);
  if (!Number.isFinite(entryId)) {
    res.status(400).json({ error: "Invalid entry id" });
    return;
  }

  const [updated] = await db
    .update(vaultEntriesTable)
    .set({ archivedAt: null, status: "draft", updatedAt: new Date(), updatedBy: userId })
    .where(and(eq(vaultEntriesTable.id, entryId), eq(vaultEntriesTable.userId, userId)))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }

  res.json(updated);
});

// ── GET /api/vault/:id/versions — version history ────────────────────────────
router.get("/vault/:id/versions", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const entryId = parseInt(req.params.id, 10);
  if (!Number.isFinite(entryId)) {
    res.status(400).json({ error: "Invalid entry id" });
    return;
  }

  const [entry] = await db
    .select({ id: vaultEntriesTable.id })
    .from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.id, entryId), eq(vaultEntriesTable.userId, userId)));

  if (!entry) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }

  const versions = await db
    .select()
    .from(vaultVersionsTable)
    .where(eq(vaultVersionsTable.entryId, entryId))
    .orderBy(desc(vaultVersionsTable.version));

  res.json(versions);
});

export default router;
