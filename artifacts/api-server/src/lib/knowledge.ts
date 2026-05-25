// ─────────────────────────────────────────────────────────────────────────────
// Knowledge Vault helper — write project-level and global knowledge entries.
//
// All writes are best-effort: a failure never blocks the main operation.
// ─────────────────────────────────────────────────────────────────────────────

import { db, knowledgeEntriesTable, type DiffSummary } from "@workspace/db";
import { and, eq, isNull, like } from "drizzle-orm";
import { logger } from "./logger";
import { buildEmbeddingInput, generateEmbedding } from "./embeddings";

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

export async function writeKnowledge(opts: KnowledgeWriteOpts): Promise<void> {
  try {
    const tagsCsv = opts.tags ? opts.tags.join(",") : null;
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
      })
      .returning({ id: knowledgeEntriesTable.id });

    // Generate and store the embedding asynchronously — never block the caller
    // on the OpenAI round-trip, and never fail the write if embeddings fail.
    if (row) {
      const insertedId = row.id;
      const inputText = buildEmbeddingInput(opts.title, opts.content, tagsCsv);
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
  } catch (err) {
    logger.error({ err }, "Failed to write Knowledge Vault entry — non-fatal");
  }
}
