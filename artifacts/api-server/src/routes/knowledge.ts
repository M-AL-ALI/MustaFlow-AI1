import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  db,
  knowledgeEntriesTable,
  projectsTable,
  creditTransactionsTable,
  userCreditsTable,
} from "@workspace/db";
import { isAdminUser } from "../lib/adminAuth";
import { getOrCreateCredits } from "./credits";
import type { SQL } from "drizzle-orm";

const router: IRouter = Router();

// Reward tunables for public-library contributions (Task #688).
// Granted exactly once per entry, the first time its net thumbs-up rating
// (thumbsUp - thumbsDown) crosses LESSON_CONTRIBUTION_THRESHOLD.
const LESSON_CONTRIBUTION_REWARD_CREDITS = Math.max(
  0,
  parseInt(process.env.LESSON_CONTRIBUTION_REWARD_CREDITS ?? "2", 10) || 0,
);
const LESSON_CONTRIBUTION_THRESHOLD = Math.max(
  1,
  parseInt(process.env.LESSON_CONTRIBUTION_THRESHOLD ?? "5", 10) || 5,
);

// GET /api/knowledge — list knowledge entries visible to the current user.
// Query params:
//   ?projectId=<id>  — entries for a specific project (+ global)
//   ?type=<type>     — filter by entry type
//   ?severity=<sev>  — filter by severity (info|warning|error)
//   ?scope=<scope>   — filter by scope (user|project|org|global)
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
  const scopeFilter = typeof req.query.scope === "string" ? req.query.scope : null;
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
    // Authenticated, no project filter: return entries for ALL of the user's projects + global + user-scope
    const ownedProjects = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(and(eq(projectsTable.ownerId, req.userId), isNull(projectsTable.deletedAt)));
    const ownedIds = ownedProjects.map((p) => p.id);

    if (ownedIds.length > 0) {
      projectCondition = or(
        eq(knowledgeEntriesTable.approvedForReuse, true),
        inArray(knowledgeEntriesTable.projectId, ownedIds),
        and(eq(knowledgeEntriesTable.userId, req.userId), eq(knowledgeEntriesTable.scope, "user")),
      ) as SQL;
    } else {
      projectCondition = or(
        eq(knowledgeEntriesTable.approvedForReuse, true),
        and(eq(knowledgeEntriesTable.userId, req.userId), eq(knowledgeEntriesTable.scope, "user")),
      ) as SQL;
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
  if (scopeFilter) conditions.push(eq(knowledgeEntriesTable.scope, scopeFilter) as SQL);

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
    scope?: string;
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
      scope: body.scope ?? "project",
      tags: body.tags ? body.tags.join(",") : null,
      approvedForReuse: false,
    })
    .returning();

  res.status(201).json(row);
});

// PATCH /api/knowledge/:id — update annotation, approvedForReuse, archivedAt, title, content, isPublic, scope.
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
    title?: string;
    content?: string;
    isPublic?: boolean;
    scope?: string;
  };

  const updates: Partial<{
    annotation: string | null;
    approvedForReuse: boolean;
    archivedAt: Date | null;
    title: string;
    content: string;
    isPublic: boolean;
    scope: string;
  }> = {};

  if ("annotation" in body) updates.annotation = body.annotation ?? null;
  if (typeof body.approvedForReuse === "boolean") updates.approvedForReuse = body.approvedForReuse;
  if (typeof body.archived === "boolean") updates.archivedAt = body.archived ? new Date() : null;
  if (typeof body.title === "string" && body.title.trim().length > 0)
    updates.title = body.title.trim();
  if (typeof body.content === "string" && body.content.trim().length > 0)
    updates.content = body.content.trim();
  if (typeof body.isPublic === "boolean") updates.isPublic = body.isPublic;
  if (typeof body.scope === "string") updates.scope = body.scope;

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

// POST /api/knowledge/:id/rate — record explicit thumbs-up or thumbs-down.
// Idempotent per direction: calling "up" twice increments once in each call (no deduplication).
router.post("/knowledge/:id/rate", async (req, res): Promise<void> => {
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

  const body = req.body as { rating?: "up" | "down" };
  if (body.rating !== "up" && body.rating !== "down") {
    res.status(400).json({ error: "rating must be 'up' or 'down'" });
    return;
  }

  const [existing] = await db
    .select({ id: knowledgeEntriesTable.id })
    .from(knowledgeEntriesTable)
    .where(eq(knowledgeEntriesTable.id, entryId));

  if (!existing) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }

  // Capture pre-update net score so we can detect a true "crossing" event
  // (some legacy entries may already sit above the threshold without ever
  // being rewarded — we only fire when an up-vote pushes them across).
  const [before] = await db
    .select({
      thumbsUp: knowledgeEntriesTable.thumbsUp,
      thumbsDown: knowledgeEntriesTable.thumbsDown,
    })
    .from(knowledgeEntriesTable)
    .where(eq(knowledgeEntriesTable.id, entryId));
  const previousNet = before ? before.thumbsUp - before.thumbsDown : 0;

  const [updated] = await db
    .update(knowledgeEntriesTable)
    .set(
      body.rating === "up"
        ? { thumbsUp: sql`${knowledgeEntriesTable.thumbsUp} + 1` }
        : { thumbsDown: sql`${knowledgeEntriesTable.thumbsDown} + 1` },
    )
    .where(eq(knowledgeEntriesTable.id, entryId))
    .returning();

  // Task #688 — reward the contributor when a public lesson crosses the
  // net-thumbs-up threshold. One-shot per entry (gated by contributorRewardedAt).
  // We require this rating to be the actual crossing event: it must be an
  // up-vote, and the previous net must have been below the threshold.
  let contributorRewardGranted = false;
  let contributorRewardCredits = 0;
  const updatedNet = updated ? updated.thumbsUp - updated.thumbsDown : 0;
  if (
    updated &&
    body.rating === "up" &&
    updated.userId &&
    updated.isPublic &&
    !updated.contributorRewardedAt &&
    LESSON_CONTRIBUTION_REWARD_CREDITS > 0 &&
    previousNet < LESSON_CONTRIBUTION_THRESHOLD &&
    updatedNet >= LESSON_CONTRIBUTION_THRESHOLD &&
    updated.userId !== userId // don't reward self-ratings
  ) {
    // Atomically claim the reward slot first so concurrent raters can't
    // double-grant. Only the row update that flips NULL → now() proceeds.
    const [claimed] = await db
      .update(knowledgeEntriesTable)
      .set({ contributorRewardedAt: new Date() })
      .where(
        and(
          eq(knowledgeEntriesTable.id, entryId),
          isNull(knowledgeEntriesTable.contributorRewardedAt),
        ),
      )
      .returning({ id: knowledgeEntriesTable.id });

    if (claimed) {
      try {
        const credits = await getOrCreateCredits(updated.userId);
        const newBalance = credits.balance + LESSON_CONTRIBUTION_REWARD_CREDITS;
        await db.transaction(async (tx) => {
          await tx
            .update(userCreditsTable)
            .set({ balance: newBalance, updatedAt: sql`now()` })
            .where(eq(userCreditsTable.userId, updated.userId as string));
          await tx.insert(creditTransactionsTable).values({
            userId: updated.userId as string,
            projectId: updated.projectId ?? null,
            type: "lesson_contribution",
            amount: LESSON_CONTRIBUTION_REWARD_CREDITS,
            description: `Public lesson reward: "${updated.title.slice(0, 80)}" reached ${LESSON_CONTRIBUTION_THRESHOLD} net thumbs-up`,
            balanceAfter: newBalance,
          });
        });
        contributorRewardGranted = true;
        contributorRewardCredits = LESSON_CONTRIBUTION_REWARD_CREDITS;
      } catch {
        // Best-effort: if credit accounting fails, roll back the claim so a
        // future rating can re-trigger the reward path.
        await db
          .update(knowledgeEntriesTable)
          .set({ contributorRewardedAt: null })
          .where(eq(knowledgeEntriesTable.id, entryId));
      }
    }
  }

  res.json({ ...updated, contributorRewardGranted, contributorRewardCredits });
});

// GET /api/knowledge/export — export all accessible knowledge entries as JSON.
// Returns entries the current user can see (same visibility rules as GET /api/knowledge).
router.get("/knowledge/export", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const ownedProjects = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(eq(projectsTable.ownerId, userId), isNull(projectsTable.deletedAt)));
  const ownedIds = ownedProjects.map((p) => p.id);

  const projectCondition =
    ownedIds.length > 0
      ? (or(
          eq(knowledgeEntriesTable.approvedForReuse, true),
          inArray(knowledgeEntriesTable.projectId, ownedIds),
          and(eq(knowledgeEntriesTable.userId, userId), eq(knowledgeEntriesTable.scope, "user")),
        ) as SQL)
      : (or(
          eq(knowledgeEntriesTable.approvedForReuse, true),
          and(eq(knowledgeEntriesTable.userId, userId), eq(knowledgeEntriesTable.scope, "user")),
        ) as SQL);

  const rows = await db
    .select({
      id: knowledgeEntriesTable.id,
      title: knowledgeEntriesTable.title,
      category: knowledgeEntriesTable.category,
      content: knowledgeEntriesTable.content,
      type: knowledgeEntriesTable.type,
      scope: knowledgeEntriesTable.scope,
      severity: knowledgeEntriesTable.severity,
      tags: knowledgeEntriesTable.tags,
      approvedForReuse: knowledgeEntriesTable.approvedForReuse,
      isPublic: knowledgeEntriesTable.isPublic,
      thumbsUp: knowledgeEntriesTable.thumbsUp,
      thumbsDown: knowledgeEntriesTable.thumbsDown,
      usageCount: knowledgeEntriesTable.usageCount,
      annotation: knowledgeEntriesTable.annotation,
      createdAt: knowledgeEntriesTable.createdAt,
    })
    .from(knowledgeEntriesTable)
    .where(and(projectCondition, isNull(knowledgeEntriesTable.archivedAt)))
    .orderBy(desc(knowledgeEntriesTable.createdAt))
    .limit(1000);

  res.setHeader("Content-Disposition", 'attachment; filename="knowledge-vault-export.json"');
  res.setHeader("Content-Type", "application/json");
  res.json({ exportedAt: new Date().toISOString(), count: rows.length, entries: rows });
});

// POST /api/knowledge/import — import knowledge entries from a previously exported JSON.
// Entries are inserted with the current user as owner; existing IDs are ignored (new IDs assigned).
router.post("/knowledge/import", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const body = req.body as {
    entries?: Array<{
      title?: string;
      content?: string;
      category?: string;
      type?: string;
      severity?: string;
      scope?: string;
      tags?: string | null;
      annotation?: string | null;
      approvedForReuse?: boolean;
      isPublic?: boolean;
    }>;
  };

  if (!Array.isArray(body.entries) || body.entries.length === 0) {
    res.status(400).json({ error: "entries array is required and must not be empty" });
    return;
  }

  const MAX_IMPORT = 500;
  const toImport = body.entries.slice(0, MAX_IMPORT);

  const inserted: number[] = [];
  for (const entry of toImport) {
    if (!entry.title || !entry.content) continue;
    const [row] = await db
      .insert(knowledgeEntriesTable)
      .values({
        title: String(entry.title).slice(0, 500),
        content: String(entry.content).slice(0, 10000),
        category: entry.category ?? "note",
        type: entry.type ?? "note",
        severity: (entry.severity as "info" | "warning" | "error") ?? "info",
        scope: entry.scope ?? "project",
        tags: entry.tags ?? null,
        annotation: entry.annotation ?? null,
        approvedForReuse: entry.approvedForReuse ?? false,
        isPublic: entry.isPublic ?? false,
        userId,
        projectId: null,
      })
      .returning({ id: knowledgeEntriesTable.id });
    if (row) inserted.push(row.id);
  }

  res.status(201).json({ imported: inserted.length, ids: inserted });
});

// POST /api/knowledge/infer-style — trigger style memory inference for the current user.
// Analyses the user's recent builds across all projects and writes style preferences as
// scope=user type=style_memory entries. Best-effort, non-fatal.
router.post("/knowledge/infer-style", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    // Gather existing build/refine entries for this user's projects
    const ownedProjects = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(and(eq(projectsTable.ownerId, userId), isNull(projectsTable.deletedAt)));

    const ownedIds = ownedProjects.map((p) => p.id);
    if (ownedIds.length === 0) {
      res.json({ inferred: 0, message: "No projects found to analyse." });
      return;
    }

    const recentEntries = await db
      .select({
        title: knowledgeEntriesTable.title,
        content: knowledgeEntriesTable.content,
        type: knowledgeEntriesTable.type,
        category: knowledgeEntriesTable.category,
      })
      .from(knowledgeEntriesTable)
      .where(
        and(
          inArray(knowledgeEntriesTable.projectId, ownedIds),
          isNull(knowledgeEntriesTable.archivedAt),
          or(
            eq(knowledgeEntriesTable.type, "build"),
            eq(knowledgeEntriesTable.type, "refine"),
            eq(knowledgeEntriesTable.type, "lesson"),
          ),
        ),
      )
      .orderBy(desc(knowledgeEntriesTable.createdAt))
      .limit(60);

    if (recentEntries.length === 0) {
      res.json({ inferred: 0, message: "No build history to analyse yet." });
      return;
    }

    // Use OpenAI to extract style preferences from the build history
    const { openai } = await import("@workspace/integrations-openai-ai-server");
    const corpus = recentEntries
      .map((e) => `[${e.type}/${e.category}] ${e.title}: ${e.content}`)
      .join("\n");

    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 2048,
      messages: [
        {
          role: "system",
          content: `You analyse a user's build history and extract their style preferences. Output STRICT JSON:
{
  "preferences": [
    { "title": string, "content": string, "category": string }
  ]
}
Each preference should be a specific, actionable inferred style rule. Examples:
- "Prefers dark UI themes with slate/zinc colour palettes"
- "Always uses Tailwind CSS for styling"
- "Prefers concise variable names using camelCase"
- "Favours chart.js for data visualisation"
Extract 3–8 distinct, confident preferences. Only include preferences you can clearly infer from the data.`,
        },
        {
          role: "user",
          content: `Here is the build history to analyse:\n\n${corpus.slice(0, 6000)}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    let parsed: { preferences?: Array<{ title: string; content: string; category: string }> };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      parsed = {};
    }

    const preferences = parsed.preferences ?? [];
    if (preferences.length === 0) {
      res.json({ inferred: 0, message: "No strong style preferences could be inferred yet." });
      return;
    }

    // Delete old unreviewed style_memory entries for this user before writing new ones
    // so we don't accumulate stale inferences.
    const existingStyleEntries = await db
      .select({ id: knowledgeEntriesTable.id })
      .from(knowledgeEntriesTable)
      .where(
        and(
          eq(knowledgeEntriesTable.userId, userId),
          eq(knowledgeEntriesTable.type, "style_memory"),
          eq(knowledgeEntriesTable.approvedForReuse, false),
        ),
      );

    if (existingStyleEntries.length > 0) {
      await db
        .update(knowledgeEntriesTable)
        .set({ archivedAt: new Date() })
        .where(
          inArray(
            knowledgeEntriesTable.id,
            existingStyleEntries.map((e) => e.id),
          ),
        );
    }

    const inserted: number[] = [];
    for (const pref of preferences) {
      if (!pref.title || !pref.content) continue;
      const [row] = await db
        .insert(knowledgeEntriesTable)
        .values({
          title: pref.title.slice(0, 500),
          content: pref.content.slice(0, 5000),
          category: pref.category ?? "style",
          type: "style_memory",
          scope: "user",
          severity: "info",
          userId,
          projectId: null,
          approvedForReuse: false,
        })
        .returning({ id: knowledgeEntriesTable.id });
      if (row) inserted.push(row.id);
    }

    res.json({
      inferred: inserted.length,
      ids: inserted,
      message: `Inferred ${inserted.length} style preference${inserted.length !== 1 ? "s" : ""} from your build history.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: "Style inference failed", detail: message });
  }
});

// GET /api/knowledge/brand-profile — return the current user's saved brand profile,
// or null if they haven't set one. The brand profile is stored as a single
// type=style_memory, category=brand_profile, scope=user entry per user.
router.get("/knowledge/brand-profile", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const [row] = await db
    .select()
    .from(knowledgeEntriesTable)
    .where(
      and(
        eq(knowledgeEntriesTable.userId, userId),
        eq(knowledgeEntriesTable.type, "style_memory"),
        eq(knowledgeEntriesTable.category, "brand_profile"),
        isNull(knowledgeEntriesTable.archivedAt),
      ),
    )
    .orderBy(desc(knowledgeEntriesTable.createdAt))
    .limit(1);

  if (!row) {
    res.json({ profile: null });
    return;
  }

  let parsed: {
    primaryColor?: string;
    accentColor?: string;
    fontPairing?: string;
    tone?: string;
  } = {};
  try {
    if (row.annotation) parsed = JSON.parse(row.annotation) as typeof parsed;
  } catch {
    parsed = {};
  }

  res.json({
    profile: {
      id: row.id,
      primaryColor: parsed.primaryColor ?? "",
      accentColor: parsed.accentColor ?? "",
      fontPairing: parsed.fontPairing ?? "",
      tone: parsed.tone ?? "",
      content: row.content,
      updatedAt: row.createdAt,
    },
  });
});

// PUT /api/knowledge/brand-profile — upsert the current user's brand profile.
// Body: { primaryColor?, accentColor?, fontPairing?, tone? }
// All fields are optional individually but at least one must be non-empty.
router.put("/knowledge/brand-profile", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const body = req.body as {
    primaryColor?: string;
    accentColor?: string;
    fontPairing?: string;
    tone?: string;
  };

  const clean = {
    primaryColor: (body.primaryColor ?? "").trim().slice(0, 32),
    accentColor: (body.accentColor ?? "").trim().slice(0, 32),
    fontPairing: (body.fontPairing ?? "").trim().slice(0, 120),
    tone: (body.tone ?? "").trim().slice(0, 60),
  };

  if (!clean.primaryColor && !clean.accentColor && !clean.fontPairing && !clean.tone) {
    res.status(400).json({ error: "At least one brand field must be provided" });
    return;
  }

  const lines: string[] = ["User-declared brand profile (apply this to every new build):"];
  if (clean.primaryColor) lines.push(`- Primary colour: ${clean.primaryColor}`);
  if (clean.accentColor) lines.push(`- Accent colour: ${clean.accentColor}`);
  if (clean.fontPairing) lines.push(`- Font pairing: ${clean.fontPairing}`);
  if (clean.tone) lines.push(`- Writing tone: ${clean.tone}`);
  const content = lines.join("\n");
  const annotation = JSON.stringify(clean);

  const [existing] = await db
    .select({ id: knowledgeEntriesTable.id })
    .from(knowledgeEntriesTable)
    .where(
      and(
        eq(knowledgeEntriesTable.userId, userId),
        eq(knowledgeEntriesTable.type, "style_memory"),
        eq(knowledgeEntriesTable.category, "brand_profile"),
      ),
    )
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(knowledgeEntriesTable)
      .set({
        title: "Brand Profile",
        content,
        annotation,
        archivedAt: null,
        approvedForReuse: false,
      })
      .where(eq(knowledgeEntriesTable.id, existing.id))
      .returning();
    res.json({ profile: { ...clean, id: updated?.id, content } });
    return;
  }

  const [row] = await db
    .insert(knowledgeEntriesTable)
    .values({
      title: "Brand Profile",
      content,
      category: "brand_profile",
      type: "style_memory",
      scope: "user",
      severity: "info",
      userId,
      projectId: null,
      annotation,
      approvedForReuse: false,
    })
    .returning();

  res.json({ profile: { ...clean, id: row?.id, content } });
});

// DELETE /api/knowledge/brand-profile — clear the user's brand profile.
router.delete("/knowledge/brand-profile", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  await db
    .delete(knowledgeEntriesTable)
    .where(
      and(
        eq(knowledgeEntriesTable.userId, userId),
        eq(knowledgeEntriesTable.type, "style_memory"),
        eq(knowledgeEntriesTable.category, "brand_profile"),
      ),
    );

  res.json({ deleted: true });
});

// GET /api/knowledge/public — public community library (no auth required).
// Returns entries that are isPublic=true and approvedForReuse=true, anonymized.
router.get("/knowledge/public", async (req, res): Promise<void> => {
  const typeFilter = typeof req.query.type === "string" ? req.query.type : null;
  const categoryFilter = typeof req.query.category === "string" ? req.query.category : null;
  const limit = Math.min(
    100,
    typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) || 20 : 20,
  );
  const offset = typeof req.query.offset === "string" ? parseInt(req.query.offset, 10) || 0 : 0;

  const conditions: SQL[] = [
    eq(knowledgeEntriesTable.isPublic, true) as SQL,
    eq(knowledgeEntriesTable.approvedForReuse, true) as SQL,
    isNull(knowledgeEntriesTable.archivedAt) as SQL,
  ];

  if (typeFilter) conditions.push(eq(knowledgeEntriesTable.type, typeFilter) as SQL);
  if (categoryFilter) conditions.push(eq(knowledgeEntriesTable.category, categoryFilter) as SQL);

  const rows = await db
    .select({
      id: knowledgeEntriesTable.id,
      title: knowledgeEntriesTable.title,
      category: knowledgeEntriesTable.category,
      content: knowledgeEntriesTable.content,
      type: knowledgeEntriesTable.type,
      severity: knowledgeEntriesTable.severity,
      tags: knowledgeEntriesTable.tags,
      thumbsUp: knowledgeEntriesTable.thumbsUp,
      thumbsDown: knowledgeEntriesTable.thumbsDown,
      usageCount: knowledgeEntriesTable.usageCount,
      createdAt: knowledgeEntriesTable.createdAt,
    })
    .from(knowledgeEntriesTable)
    .where(and(...conditions))
    .orderBy(desc(knowledgeEntriesTable.thumbsUp))
    .limit(limit)
    .offset(offset);

  res.json(rows);
});

// DELETE /api/knowledge/:id — hard-delete a knowledge entry.
// Authorization: requester must own the entry (entry.userId === req.userId) OR be admin.
// System entries (userId = null) can only be deleted by admin.
router.delete("/knowledge/:id", async (req, res): Promise<void> => {
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

  const isOwner = existing.userId !== null && existing.userId === userId;
  const isAdmin = await isAdminUser(userId);

  if (!isOwner && !isAdmin) {
    res.status(403).json({ error: "You do not have permission to delete this entry" });
    return;
  }

  await db.delete(knowledgeEntriesTable).where(eq(knowledgeEntriesTable.id, entryId));

  res.json({ deleted: true });
});

export default router;
