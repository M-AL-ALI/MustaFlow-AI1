/**
 * Knowledge Vault auto-promotion scheduler.
 *
 * Periodically scans project-scoped knowledge entries that have accumulated
 * enough positive signal (thumbsUp >= 3 and usageCount >= 2) but have not yet
 * been promoted to the global pool. Qualifying entries are stamped with
 * approvedForReuse=true, isPublic=true, scope='global' so they participate in
 * cross-project context retrieval for all users.
 *
 * Runs once ~1 minute after boot, then every 6 hours alongside other schedulers.
 * All errors are logged and swallowed — a failure never crashes the process.
 */

import { db, knowledgeEntriesTable, projectsTable } from "@workspace/db";
import { and, eq, gte, isNull } from "drizzle-orm";
import { logger } from "./logger";
import { buildEmbeddingInput, generateEmbedding } from "./embeddings";

const THUMBS_UP_THRESHOLD = 3;
const USAGE_COUNT_THRESHOLD = 2;
const INITIAL_DELAY_MS = 60_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 h

export interface KnowledgePromotionResult {
  promoted: number;
  skipped: number;
}

/**
 * Anonymise an entry's title/content before it crosses into the global pool.
 * Strips project-specific identifiers (emails, long numeric IDs, and any
 * caller-supplied terms such as the project name) that could leak identifiable
 * data to other tenants via cross-project retrieval.
 *
 * Exported so the manual-promote route applies the same sanitization.
 *
 * @param text        Raw title or content string to sanitize.
 * @param extraTerms  Additional literal strings to strip (e.g. project name,
 *                    workspace slug). Case-insensitive matching.
 */
export function anonymiseContent(text: string, extraTerms: string[] = []): string {
  let out = text
    // Strip email addresses
    .replace(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, "[email]")
    // Strip long numeric IDs (6+ digits)
    .replace(/\b\d{6,}\b/g, "[id]");

  // Strip any caller-supplied identifiers (project name, slug, etc.)
  for (const term of extraTerms) {
    if (!term || term.length < 3) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), "[name]");
  }

  return out.trim();
}

/**
 * Run one auto-promotion pass.
 * Exported for tests and ad-hoc invocation.
 */
export async function promoteHighQualityLessons(): Promise<KnowledgePromotionResult> {
  let promoted = 0;
  let skipped = 0;

  try {
    // Join the projects table so we can strip the project name from promoted content.
    const candidates = await db
      .select({
        entry: knowledgeEntriesTable,
        projectName: projectsTable.name,
      })
      .from(knowledgeEntriesTable)
      .leftJoin(projectsTable, eq(knowledgeEntriesTable.projectId, projectsTable.id))
      .where(
        and(
          eq(knowledgeEntriesTable.approvedForReuse, false),
          gte(knowledgeEntriesTable.thumbsUp, THUMBS_UP_THRESHOLD),
          gte(knowledgeEntriesTable.usageCount, USAGE_COUNT_THRESHOLD),
          isNull(knowledgeEntriesTable.archivedAt),
          // Only promote project-scoped entries (not already global/user/org)
          eq(knowledgeEntriesTable.scope, "project"),
        ),
      )
      .limit(100);

    if (candidates.length === 0) {
      logger.debug("knowledge-promotion: no candidates to promote");
      return { promoted: 0, skipped: 0 };
    }

    logger.info({ count: candidates.length }, "knowledge-promotion: processing candidates");

    for (const { entry, projectName } of candidates) {
      try {
        const projectTerms = projectName ? [projectName] : [];
        const cleanTitle = anonymiseContent(entry.title, projectTerms);
        const cleanContent = anonymiseContent(entry.content, projectTerms);

        await db
          .update(knowledgeEntriesTable)
          .set({
            approvedForReuse: true,
            isPublic: true,
            scope: "global",
            title: cleanTitle,
            content: cleanContent,
          })
          .where(eq(knowledgeEntriesTable.id, entry.id));

        // Regenerate the embedding with the (possibly sanitised) text so semantic
        // search picks up the global entry correctly.
        const inputText = buildEmbeddingInput(cleanTitle, cleanContent, entry.tags);
        void generateEmbedding(inputText)
          .then(async (vec) => {
            if (!vec) return;
            await db
              .update(knowledgeEntriesTable)
              .set({ embedding: vec })
              .where(eq(knowledgeEntriesTable.id, entry.id));
          })
          .catch((err: unknown) => {
            logger.warn(
              { err, id: entry.id },
              "knowledge-promotion: embedding regeneration failed",
            );
          });

        promoted++;
      } catch (err) {
        logger.warn({ err, id: entry.id }, "knowledge-promotion: failed to promote entry");
        skipped++;
      }
    }
  } catch (err) {
    logger.warn({ err }, "knowledge-promotion: scan query failed");
  }

  if (promoted > 0 || skipped > 0) {
    logger.info({ promoted, skipped }, "knowledge-promotion: pass complete");
  }

  return { promoted, skipped };
}

export function startKnowledgePromotionScheduler(): void {
  logger.info(
    { initialDelayMs: INITIAL_DELAY_MS, intervalMs: INTERVAL_MS },
    "knowledge-promotion scheduler: starting",
  );

  setTimeout(() => {
    void promoteHighQualityLessons().catch((err: unknown) => {
      logger.warn({ err }, "knowledge-promotion: initial pass failed");
    });
    setInterval(() => {
      void promoteHighQualityLessons().catch((err: unknown) => {
        logger.warn({ err }, "knowledge-promotion: scheduled pass failed");
      });
    }, INTERVAL_MS);
  }, INITIAL_DELAY_MS);
}
