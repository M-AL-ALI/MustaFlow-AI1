// ─────────────────────────────────────────────────────────────────────────────
// Knowledge Vault helper — write project-level and global knowledge entries.
//
// All writes are best-effort: a failure never blocks the main operation.
// ─────────────────────────────────────────────────────────────────────────────

import { db, knowledgeEntriesTable, projectsTable, type DiffSummary } from "@workspace/db";
import { and, desc, eq, inArray, isNotNull, isNull, like, ne, or } from "drizzle-orm";
import { logger } from "./logger";
import { buildEmbeddingInput, cosineSimilarity, generateEmbedding } from "./embeddings";
import { anonymiseContent } from "./knowledge-promotion";

export interface KnowledgeWriteOpts {
  title: string;
  content: string;
  type: string;
  category?: string;
  severity?: "info" | "warning" | "error";
  projectId?: number;
  userId?: string;
  relatedTaskId?: number;
  relatedVersionId?: number;
  tags?: string[];
  diffSummary?: DiffSummary;
  approvedForReuse?: boolean;
}

/**
 * Returns a formatted context block containing all installed-blueprint knowledge
 * entries for the given project.
 *
 * Blueprint entries are tagged with "blueprint" at install time, so they can be
 * selected directly by a tag-filter without a vector search. The result is meant
 * to be prepended to the AI system prompt unconditionally — before the
 * token-budgeted relevance-ranked lessons block — so the builder always knows
 * which integrations are already scaffolded, regardless of whether the user's
 * prompt mentions them by name.
 *
 * Returns null when there are no installed blueprints (or on error).
 */
export async function getInstalledBlueprintKnowledge(projectId: number): Promise<string | null> {
  try {
    const entries = await db
      .select({
        id: knowledgeEntriesTable.id,
        title: knowledgeEntriesTable.title,
        content: knowledgeEntriesTable.content,
        tags: knowledgeEntriesTable.tags,
      })
      .from(knowledgeEntriesTable)
      .where(
        and(
          eq(knowledgeEntriesTable.projectId, projectId),
          like(knowledgeEntriesTable.tags, "%blueprint%"),
          isNull(knowledgeEntriesTable.archivedAt),
        ),
      )
      .orderBy(knowledgeEntriesTable.id);

    if (entries.length === 0) return null;

    const lines = entries.map((e) => `- ${e.content}`).join("\n\n");
    return [
      `=== INSTALLED BLUEPRINTS & INTEGRATIONS (${entries.length} installed) ===`,
      `The following integrations have already been scaffolded in this project.`,
      `Always use these existing patterns and files — never re-implement from scratch.`,
      ``,
      lines,
      `=== END INSTALLED BLUEPRINTS ===`,
    ].join("\n");
  } catch (err) {
    logger.warn({ err, projectId }, "getInstalledBlueprintKnowledge failed — non-fatal");
    return null;
  }
}

const KNOWLEDGE_DEDUP_THRESHOLD = parseFloat(process.env.KNOWLEDGE_DEDUP_THRESHOLD ?? "0.88");

export async function writeKnowledge(opts: KnowledgeWriteOpts): Promise<void> {
  try {
    const tagsCsv = opts.tags ? opts.tags.join(",") : null;

    // ── Step 1: Generate embedding synchronously before insert decision ───────
    // On failure, embedding = null and we skip dedup, falling through to insert.
    const inputText = buildEmbeddingInput(opts.title, opts.content, tagsCsv);
    let embedding: number[] | null = null;
    try {
      embedding = await generateEmbedding(inputText);
    } catch (err) {
      logger.warn({ err }, "writeKnowledge: embedding generation failed — skipping dedup");
    }

    // ── Step 2: Attempt semantic deduplication when embedding is available ────
    if (embedding !== null) {
      // Only consider non-promoted, non-global, non-archived entries of the same
      // type. Globally-promoted entries must never be used as merge targets to
      // avoid leaking tenant data into the global pool.
      const candidates =
        opts.projectId != null
          ? await db
              .select()
              .from(knowledgeEntriesTable)
              .where(
                and(
                  eq(knowledgeEntriesTable.projectId, opts.projectId),
                  eq(knowledgeEntriesTable.type, opts.type),
                  eq(knowledgeEntriesTable.approvedForReuse, false),
                  ne(knowledgeEntriesTable.scope, "global"),
                  // ISOLATION: writeKnowledge only ever produces Builder entries,
                  // so a near-duplicate may only merge into another Builder row —
                  // never into an Ora memory. (NULL origin is legacy Builder data.)
                  or(isNull(knowledgeEntriesTable.origin), ne(knowledgeEntriesTable.origin, "ora")),
                  isNull(knowledgeEntriesTable.archivedAt),
                  isNotNull(knowledgeEntriesTable.embedding),
                ),
              )
              .orderBy(desc(knowledgeEntriesTable.createdAt))
              .limit(50)
          : opts.userId != null
            ? await db
                .select()
                .from(knowledgeEntriesTable)
                .where(
                  and(
                    eq(knowledgeEntriesTable.userId, opts.userId),
                    isNull(knowledgeEntriesTable.projectId),
                    eq(knowledgeEntriesTable.type, opts.type),
                    eq(knowledgeEntriesTable.approvedForReuse, false),
                    ne(knowledgeEntriesTable.scope, "global"),
                    // ISOLATION: a Builder write may only merge into a Builder
                    // row, never into an Ora memory. (NULL origin = legacy Builder.)
                    or(
                      isNull(knowledgeEntriesTable.origin),
                      ne(knowledgeEntriesTable.origin, "ora"),
                    ),
                    isNull(knowledgeEntriesTable.archivedAt),
                    isNotNull(knowledgeEntriesTable.embedding),
                  ),
                )
                .orderBy(desc(knowledgeEntriesTable.createdAt))
                .limit(50)
            : [];

      // Find the best-matching candidate above the dedup threshold
      let bestId: number | null = null;
      let bestSimilarity = 0;
      let bestContent = "";
      let bestReinforcedCount = 0;
      for (const candidate of candidates) {
        const candidateEmbedding = candidate.embedding;
        if (!Array.isArray(candidateEmbedding)) continue;
        const sim = cosineSimilarity(embedding, candidateEmbedding as number[]);
        if (sim > bestSimilarity) {
          bestSimilarity = sim;
          bestId = candidate.id;
          bestContent = candidate.content;
          bestReinforcedCount = candidate.reinforcedCount ?? 0;
        }
      }

      if (bestId !== null && bestSimilarity >= KNOWLEDGE_DEDUP_THRESHOLD) {
        // Merge into existing entry — sanitize new content before appending
        const safeNew = anonymiseContent(opts.content);
        const today = new Date().toISOString().slice(0, 10);
        await db
          .update(knowledgeEntriesTable)
          .set({
            content: `${bestContent}\n\n[Reinforced ${today}]: ${safeNew}`,
            reinforcedCount: bestReinforcedCount + 1,
            embedding,
          })
          .where(eq(knowledgeEntriesTable.id, bestId));
        logger.debug(
          { id: bestId, similarity: bestSimilarity },
          "writeKnowledge: merged near-duplicate into existing entry",
        );
        return;
      }
    }

    // ── Step 3: No duplicate found (or no embedding) — insert as normal ───────
    const [row] = await db
      .insert(knowledgeEntriesTable)
      .values({
        title: opts.title,
        content: opts.content,
        type: opts.type,
        category: opts.category ?? "note",
        severity: opts.severity ?? "info",
        projectId: opts.projectId ?? null,
        userId: opts.userId ?? null,
        relatedTaskId: opts.relatedTaskId ?? null,
        relatedVersionId: opts.relatedVersionId ?? null,
        tags: tagsCsv,
        approvedForReuse: opts.approvedForReuse ?? false,
        diffSummary: opts.diffSummary ?? null,
        // AI Builder Knowledge Vault provenance — never surfaced by Ora.
        origin: "builder",
        // Include the embedding directly if already generated — skip the post-insert async update
        ...(embedding !== null ? { embedding } : {}),
      })
      .returning({ id: knowledgeEntriesTable.id });

    // If embedding generation failed above, retry async so we at least get it eventually
    if (row && embedding === null) {
      const insertedId = row.id;
      void generateEmbedding(inputText)
        .then(async (vec) => {
          if (!vec) return;
          try {
            await db
              .update(knowledgeEntriesTable)
              .set({ embedding: vec })
              .where(eq(knowledgeEntriesTable.id, insertedId));
          } catch (err) {
            logger.warn({ err, id: insertedId }, "Failed to store knowledge embedding");
          }
        })
        .catch((err: unknown) => {
          logger.warn({ err, id: row.id }, "Embedding generation rejected");
        });
    }
  } catch (err) {
    logger.error({ err }, "Failed to write Knowledge Vault entry — non-fatal");
  }
}

/**
 * Infer style preferences for a user from their build history and write them
 * as scope=user type=style_memory knowledge entries.
 *
 * Extracted from the POST /api/knowledge/infer-style route handler so it can
 * be called from within the build pipeline (auto-refresh after every build).
 *
 * Returns { inferred: number } — the count of style preference entries written.
 * All errors are swallowed by callers — treat this as best-effort.
 */
export async function inferStyleForUser(userId: string): Promise<{ inferred: number }> {
  // Gather existing build/refine entries for this user's projects
  const ownedProjects = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(eq(projectsTable.ownerId, userId), isNull(projectsTable.deletedAt)));

  const ownedIds = ownedProjects.map((p) => p.id);
  if (ownedIds.length === 0) {
    return { inferred: 0 };
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
    return { inferred: 0 };
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
    return { inferred: 0 };
  }

  // Delete old unreviewed style_memory entries for this user before writing new ones
  // so we don't accumulate stale inferences.
  // Explicitly exclude brand_profile entries — they are managed separately via
  // PUT /api/knowledge/brand-profile and must never be clobbered by auto-inference.
  const existingStyleEntries = await db
    .select({ id: knowledgeEntriesTable.id })
    .from(knowledgeEntriesTable)
    .where(
      and(
        eq(knowledgeEntriesTable.userId, userId),
        eq(knowledgeEntriesTable.type, "style_memory"),
        ne(knowledgeEntriesTable.category, "brand_profile"),
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

  const validPrefs = preferences.filter((p) => p.title && p.content);
  if (validPrefs.length === 0) {
    return { inferred: 0 };
  }

  const rows = await db
    .insert(knowledgeEntriesTable)
    .values(
      validPrefs.map((pref) => ({
        title: pref.title.slice(0, 500),
        content: pref.content.slice(0, 5000),
        category: pref.category ?? "style",
        type: "style_memory",
        scope: "user",
        severity: "info" as const,
        userId,
        projectId: null as number | null,
        approvedForReuse: false,
        // Builder-inferred style memory — hidden from Ora Memory.
        origin: "builder" as const,
      })),
    )
    .returning({ id: knowledgeEntriesTable.id });

  return { inferred: rows.length };
}
