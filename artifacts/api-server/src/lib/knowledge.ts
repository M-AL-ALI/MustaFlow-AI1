// ─────────────────────────────────────────────────────────────────────────────
// Knowledge Vault helper — write project-level and global knowledge entries.
//
// All writes are best-effort: a failure never blocks the main operation.
// ─────────────────────────────────────────────────────────────────────────────

import { db, knowledgeEntriesTable, type DiffSummary } from "@workspace/db";
import { logger } from "./logger";

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
    await db.insert(knowledgeEntriesTable).values({
      title: opts.title,
      content: opts.content,
      type: opts.type,
      category: opts.category ?? "note",
      severity: opts.severity ?? "info",
      projectId: opts.projectId ?? null,
      userId: opts.userId ?? null,
      relatedTaskId: opts.relatedTaskId ?? null,
      relatedVersionId: opts.relatedVersionId ?? null,
      tags: opts.tags ? opts.tags.join(",") : null,
      approvedForReuse: opts.approvedForReuse ?? false,
      diffSummary: opts.diffSummary ?? null,
    });
  } catch (err) {
    logger.error({ err }, "Failed to write Knowledge Vault entry — non-fatal");
  }
}
