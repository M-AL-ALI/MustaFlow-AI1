// ─────────────────────────────────────────────────────────────────────────────
// Knowledge Vault helper — write project-level and global knowledge entries.
//
// All writes are best-effort: a failure never blocks the main operation.
// ─────────────────────────────────────────────────────────────────────────────

import { db, knowledgeEntriesTable, type DiffSummary } from "@workspace/db";
import { eq } from "drizzle-orm";
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
