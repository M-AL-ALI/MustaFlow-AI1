// ─────────────────────────────────────────────────────────────────────────────
// Knowledge Vault helper — write project-level and global knowledge entries.
//
// All writes are best-effort: a failure never blocks the main operation.
// ─────────────────────────────────────────────────────────────────────────────

import {
  agentTasksTable,
  chatMessagesTable,
  db,
  knowledgeEntriesTable,
  knowledgeProvenanceEventsTable,
  projectBlueprintsTable,
  projectVersionsTable,
  projectsTable,
  type DiffSummary,
} from "@workspace/db";
import { and, desc, eq, inArray, isNotNull, isNull, like, ne, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { logger } from "./logger";
import { buildEmbeddingInput, cosineSimilarity, generateEmbedding } from "./embeddings";
import { anonymiseContent } from "./knowledge-promotion";
import type { ZeroGenerationTarget } from "@workspace/tenant-runtime-contracts";
import { isZeroSealedGenerationTarget } from "./zero-sealed-generation";
import {
  resolveZeroIntegrationEligibility,
  resolveZeroIntegrationEligibilityOutcome,
} from "./zero-capability-eligibility";
import type { ZeroMemoryClaimKind } from "@workspace/ora-contracts";

export interface KnowledgeWriteOpts {
  title: string;
  content: string;
  type: string;
  category?: string;
  scope?: "project" | "user" | "org" | "global";
  severity?: "info" | "warning" | "error";
  projectId?: number;
  userId?: string;
  relatedTaskId?: number;
  relatedVersionId?: number;
  sourceMessageStartId?: number;
  sourceMessageEndId?: number;
  tags?: string[];
  diffSummary?: DiffSummary;
  approvedForReuse?: boolean;
  /** Closed provenance class. Automated system facts default to observed. */
  claimKind?: ZeroMemoryClaimKind;
  /** Actor responsible for a stated claim. Never returned directly to clients. */
  actorUserId?: string;
}

export type KnowledgeWriteResult = {
  outcome: "inserted" | "reinforced";
  entryId: number;
};

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
export async function getInstalledBlueprintKnowledge(
  projectId: number,
  target: ZeroGenerationTarget = "legacy-v1",
): Promise<string | null> {
  try {
    if (isZeroSealedGenerationTarget(target)) {
      const installed = await db
        .select({ blueprintId: projectBlueprintsTable.blueprintId })
        .from(projectBlueprintsTable)
        .where(eq(projectBlueprintsTable.projectId, projectId))
        .orderBy(projectBlueprintsTable.blueprintId);
      if (installed.length === 0) return null;
      const lines: string[] = [];
      for (const entry of installed) {
        const metadata = await resolveZeroIntegrationEligibility("blueprint", entry.blueprintId);
        if (metadata.cloudflare.status === "eligible") {
          lines.push(`- ${entry.blueprintId}: ${metadata.cloudflare.sealedGuidance}`);
        } else {
          const outcome = await resolveZeroIntegrationEligibilityOutcome(
            "blueprint",
            entry.blueprintId,
          );
          if (outcome.ok)
            throw new Error("Zero blueprint metadata outcome disagrees with contract");
          lines.push(
            `- ${JSON.stringify({
              ok: false,
              code: "zero_capability_gap",
              retryable: false,
              identitySha256: outcome.identitySha256,
              integration: { kind: "blueprint", id: entry.blueprintId },
              reasons: outcome.reasons,
              resolution: "select-supported-implementation",
            })}`,
          );
        }
      }
      return [
        `=== SEALED BLUEPRINT CAPABILITY GUIDANCE (${installed.length} installed) ===`,
        `Use only capability-backed guidance below. A capability gap requires an automatic supported implementation; never request credentials, egress, or Pantry configuration.`,
        "",
        ...lines,
        `=== END SEALED BLUEPRINT CAPABILITY GUIDANCE ===`,
      ].join("\n");
    }
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
    if (isZeroSealedGenerationTarget(target)) throw err;
    logger.warn({ err, projectId }, "getInstalledBlueprintKnowledge failed — non-fatal");
    return null;
  }
}

const KNOWLEDGE_DEDUP_THRESHOLD = parseFloat(process.env.KNOWLEDGE_DEDUP_THRESHOLD ?? "0.88");

function contentSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type KnowledgeProvenanceReceiptInput = {
  knowledgeEntryId: number;
  outcome: "inserted" | "reinforced";
  projectId?: number | null;
  sourceMessageStartId?: number | null;
  sourceMessageEndId?: number | null;
  sourceTaskId?: number | null;
  sourceVersionId?: number | null;
  claimKind: ZeroMemoryClaimKind;
  actorUserId?: string | null;
  contributedContent: string;
  resultingContent: string;
};

/** The sole constructor for append-only Builder memory provenance receipts. */
export function buildKnowledgeProvenanceReceipt(input: KnowledgeProvenanceReceiptInput) {
  return {
    knowledgeEntryId: input.knowledgeEntryId,
    outcome: input.outcome,
    projectId: input.projectId ?? null,
    sourceMessageStartId: input.sourceMessageStartId ?? null,
    sourceMessageEndId: input.sourceMessageEndId ?? null,
    sourceTaskId: input.sourceTaskId ?? null,
    sourceVersionId: input.sourceVersionId ?? null,
    claimKind: input.claimKind,
    actorUserId: input.actorUserId ?? null,
    contributedContentSha256: contentSha256(input.contributedContent),
    resultingContentSha256: contentSha256(input.resultingContent),
  };
}

/**
 * The single append operation for Builder memory provenance. Callers pass
 * their existing transaction so the semantic write and its receipt commit or
 * roll back together.
 */
export async function appendKnowledgeProvenanceReceipt(
  client: Pick<typeof db, "insert">,
  input: KnowledgeProvenanceReceiptInput,
): Promise<void> {
  await client
    .insert(knowledgeProvenanceEventsTable)
    .values(buildKnowledgeProvenanceReceipt(input));
}

export async function writeKnowledge(
  opts: KnowledgeWriteOpts,
): Promise<KnowledgeWriteResult | null> {
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

    const result = await db.transaction(async (tx) => {
      const sourceIds = [
        opts.relatedTaskId,
        opts.relatedVersionId,
        opts.sourceMessageStartId,
        opts.sourceMessageEndId,
      ].filter((value): value is number => value != null);
      if (sourceIds.length > 0 && opts.projectId == null) {
        throw new Error("Knowledge provenance source requires a project");
      }
      if (opts.projectId != null) {
        if (opts.relatedTaskId != null) {
          const [source] = await tx
            .select({ projectId: agentTasksTable.projectId })
            .from(agentTasksTable)
            .where(eq(agentTasksTable.id, opts.relatedTaskId))
            .limit(1);
          if (source?.projectId !== opts.projectId) {
            throw new Error("Knowledge task provenance does not belong to the project");
          }
        }
        if (opts.relatedVersionId != null) {
          const [source] = await tx
            .select({ projectId: projectVersionsTable.projectId })
            .from(projectVersionsTable)
            .where(eq(projectVersionsTable.id, opts.relatedVersionId))
            .limit(1);
          if (source?.projectId !== opts.projectId) {
            throw new Error("Knowledge version provenance does not belong to the project");
          }
        }
        const messageIds = [opts.sourceMessageStartId, opts.sourceMessageEndId].filter(
          (value): value is number => value != null,
        );
        if (messageIds.length > 0) {
          const uniqueMessageIds = [...new Set(messageIds)];
          const sources = await tx
            .select({ id: chatMessagesTable.id, projectId: chatMessagesTable.projectId })
            .from(chatMessagesTable)
            .where(inArray(chatMessagesTable.id, uniqueMessageIds));
          if (
            sources.length !== uniqueMessageIds.length ||
            sources.some((source) => source.projectId !== opts.projectId)
          ) {
            throw new Error("Knowledge message provenance does not belong to the project");
          }
        }
      }

      // ── Step 2: Attempt semantic deduplication when embedding is available ──
      if (embedding !== null) {
        // Only consider non-promoted, non-global, non-archived entries of the same
        // type. Globally-promoted entries must never be used as merge targets to
        // avoid leaking tenant data into the global pool.
        const candidates =
          opts.projectId != null
            ? await tx
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
            : opts.userId != null
              ? await tx
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
          const resultingContent = `${bestContent}\n\n[Reinforced ${today}]: ${safeNew}`;
          await tx
            .update(knowledgeEntriesTable)
            .set({
              content: resultingContent,
              reinforcedCount: bestReinforcedCount + 1,
              embedding,
            })
            .where(eq(knowledgeEntriesTable.id, bestId));
          await appendKnowledgeProvenanceReceipt(tx, {
            knowledgeEntryId: bestId,
            outcome: "reinforced",
            projectId: opts.projectId,
            sourceMessageStartId: opts.sourceMessageStartId,
            sourceMessageEndId: opts.sourceMessageEndId,
            sourceTaskId: opts.relatedTaskId,
            sourceVersionId: opts.relatedVersionId,
            claimKind: opts.claimKind ?? "observed",
            actorUserId: opts.actorUserId ?? opts.userId,
            contributedContent: opts.content,
            resultingContent,
          });
          logger.debug(
            { id: bestId, similarity: bestSimilarity },
            "writeKnowledge: merged near-duplicate into existing entry",
          );
          return { outcome: "reinforced", entryId: bestId } satisfies KnowledgeWriteResult;
        }
      }

      // ── Step 3: No duplicate found (or no embedding) — insert as normal ─────
      const [row] = await tx
        .insert(knowledgeEntriesTable)
        .values({
          title: opts.title,
          content: opts.content,
          type: opts.type,
          category: opts.category ?? "note",
          scope: opts.scope ?? (opts.projectId != null ? "project" : "user"),
          severity: opts.severity ?? "info",
          projectId: opts.projectId ?? null,
          userId: opts.userId ?? null,
          relatedTaskId: opts.relatedTaskId ?? null,
          relatedVersionId: opts.relatedVersionId ?? null,
          sourceMessageStartId: opts.sourceMessageStartId ?? null,
          sourceMessageEndId: opts.sourceMessageEndId ?? null,
          tags: tagsCsv,
          approvedForReuse: opts.approvedForReuse ?? false,
          diffSummary: opts.diffSummary ?? null,
          origin: "builder",
          ...(embedding !== null ? { embedding } : {}),
        })
        .returning({ id: knowledgeEntriesTable.id });
      if (!row) throw new Error("Knowledge insert did not return an entry identity");
      await appendKnowledgeProvenanceReceipt(tx, {
        knowledgeEntryId: row.id,
        outcome: "inserted",
        projectId: opts.projectId,
        sourceMessageStartId: opts.sourceMessageStartId,
        sourceMessageEndId: opts.sourceMessageEndId,
        sourceTaskId: opts.relatedTaskId,
        sourceVersionId: opts.relatedVersionId,
        claimKind: opts.claimKind ?? "observed",
        actorUserId: opts.actorUserId ?? opts.userId,
        contributedContent: opts.content,
        resultingContent: opts.content,
      });
      return { outcome: "inserted", entryId: row.id } satisfies KnowledgeWriteResult;
    });

    // If embedding generation failed above, retry async so we at least get it eventually
    if (result.outcome === "inserted" && embedding === null) {
      const insertedId = result.entryId;
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
          logger.warn({ err, id: insertedId }, "Embedding generation rejected");
        });
    }
    return result;
  } catch (err) {
    logger.error({ err }, "Failed to write Knowledge Vault entry — non-fatal");
    return null;
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

  let inserted = 0;
  for (const pref of validPrefs) {
    const result = await writeKnowledge({
      title: pref.title.slice(0, 500),
      content: pref.content.slice(0, 5000),
      category: pref.category ?? "style",
      type: "style_memory",
      scope: "user",
      userId,
      approvedForReuse: false,
      claimKind: "inferred",
      actorUserId: userId,
    });
    if (result) inserted += 1;
  }

  return { inferred: inserted };
}
