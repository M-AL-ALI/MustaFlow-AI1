// ─────────────────────────────────────────────────────────────────────────────
// Phase 8B-3A: User-Approved Knowledge-Aware Reporting
//
// Builds safe, sanitized context from user-selected vault entries for injection
// into AI report prompts.  Ownership is enforced on every call.
//
// IMPORTANT invariants:
//   • Raw embedding vectors are NEVER loaded or returned.
//   • Only entries owned by the requesting user are ever included.
//   • Archived entries are excluded.
//   • Content is sanitized (secrets/tokens/credentials stripped) before
//     being placed in any AI prompt.
//   • Total context is capped at MAX_CONTEXT_CHARS.
//   • Audit events are logged non-fatally.
// ─────────────────────────────────────────────────────────────────────────────

import { db, knowledgeUsageEventsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { sanitizeText, detectSensitiveContent } from "./vault-sanitizer";
import { logger } from "./logger";

const MAX_ENTRIES = 8;
const MAX_CONTEXT_CHARS = 10_000;
const MAX_CHUNK_CHARS = 800;

// ── Public types ──────────────────────────────────────────────────────────────

export interface ApprovedKnowledgeEntry {
  entryId: number;
  title: string;
  category: string;
  department: string | null;
  summary: string;
  chunkPreview: string;
  version: number;
  updatedAt: string;
  sourceRef: string;
  skipped: boolean;
  skipReason?: string;
}

export interface ApprovedKnowledgeContext {
  entries: ApprovedKnowledgeEntry[];
  promptBlock: string;
  totalChars: number;
  skippedCount: number;
}

export interface KnowledgeUsageEvent {
  userId: string;
  query: string;
  reportType: string;
  selectedEntryIds: number[];
  selectedEntryVersions: number[];
  entryCount: number;
}

// ── buildApprovedKnowledgeContext ─────────────────────────────────────────────

export async function buildApprovedKnowledgeContext(params: {
  userId: string;
  selectedEntryIds: number[];
  maxEntries?: number;
  maxChars?: number;
}): Promise<ApprovedKnowledgeContext> {
  const { userId, selectedEntryIds } = params;
  const maxEntries = Math.min(params.maxEntries ?? MAX_ENTRIES, MAX_ENTRIES);
  const maxChars = Math.min(params.maxChars ?? MAX_CONTEXT_CHARS, MAX_CONTEXT_CHARS);

  if (selectedEntryIds.length === 0) {
    return { entries: [], promptBlock: "", totalChars: 0, skippedCount: 0 };
  }

  // Validate: all IDs must be positive integers before any DB call
  const safeIds = selectedEntryIds.filter((id) => Number.isInteger(id) && id > 0);
  if (safeIds.length === 0) {
    return { entries: [], promptBlock: "", totalChars: 0, skippedCount: 0 };
  }

  type Row = {
    id: number;
    title: string;
    category: string;
    department: string | null;
    summary: string;
    content: string;
    version: number;
    status: string;
    updatedAt: string;
    userId: string;
  };

  const idLiterals = safeIds.map((id) => sql`${id}`);
  const inClause = sql.join(idLiterals, sql`, `);

  const result = await db.execute<Row>(sql`
    SELECT id, title, category, department, summary, content,
           version, status,
           updated_at::text AS "updatedAt",
           user_id          AS "userId"
    FROM vault_entries
    WHERE id IN (${inClause})
      AND archived_at IS NULL
  `);

  const entries: ApprovedKnowledgeEntry[] = [];
  let totalChars = 0;
  let skippedCount = 0;

  for (const row of result.rows.slice(0, maxEntries)) {
    // ─── Ownership enforcement ─────────────────────────────────────────────
    if (row.userId !== userId) {
      skippedCount++;
      logger.warn({ entryId: row.id, userId }, "vault-knowledge: ownership mismatch — skipped");
      continue;
    }

    // ─── Reject archived entries ───────────────────────────────────────────
    if (row.status === "archived") {
      skippedCount++;
      entries.push({
        entryId: row.id,
        title: row.title,
        category: row.category,
        department: row.department ?? null,
        summary: "[This entry is archived and cannot be used in reports]",
        chunkPreview: "",
        version: row.version,
        updatedAt: row.updatedAt ?? new Date().toISOString(),
        sourceRef: `vault-entry-${row.id}`,
        skipped: true,
        skipReason: "archived",
      });
      continue;
    }

    // ─── Sensitive content detection ───────────────────────────────────────
    const combined = `${row.title} ${row.summary} ${row.content}`;
    const sensitiveIssue = detectSensitiveContent(combined);
    if (sensitiveIssue) {
      skippedCount++;
      logger.warn(
        { entryId: row.id, issue: sensitiveIssue },
        "vault-knowledge: sensitive content detected — skipped",
      );
      entries.push({
        entryId: row.id,
        title: row.title,
        category: row.category,
        department: row.department ?? null,
        summary: "[This entry could not be used: sensitive content detected]",
        chunkPreview: "",
        version: row.version,
        updatedAt: row.updatedAt ?? new Date().toISOString(),
        sourceRef: `vault-entry-${row.id}`,
        skipped: true,
        skipReason: "sensitive content",
      });
      continue;
    }

    // ─── Sanitize + cap ───────────────────────────────────────────────────
    const safeTitle = sanitizeText(row.title);
    const safeSummary = sanitizeText(row.summary);
    const safeContent = sanitizeText(row.content);
    const chunkPreview = safeContent.slice(0, MAX_CHUNK_CHARS);

    if (totalChars + chunkPreview.length > maxChars) {
      skippedCount++;
      continue;
    }

    totalChars += chunkPreview.length;
    entries.push({
      entryId: row.id,
      title: safeTitle,
      category: row.category,
      department: row.department ?? null,
      summary: safeSummary,
      chunkPreview,
      version: row.version,
      updatedAt: row.updatedAt ?? new Date().toISOString(),
      sourceRef: `vault-entry-${row.id}`,
      skipped: false,
    });
  }

  const activeEntries = entries.filter((e) => !e.skipped);
  const promptBlock = buildPromptBlock(activeEntries);

  return { entries, promptBlock, totalChars, skippedCount };
}

// ── buildPromptBlock ──────────────────────────────────────────────────────────

function buildPromptBlock(entries: ApprovedKnowledgeEntry[]): string {
  if (entries.length === 0) return "";

  const lines: string[] = [
    "--- APPROVED KNOWLEDGE VAULT CONTEXT ---",
    "Use only the following user-approved Knowledge Vault entries as supporting context.",
    "Do not treat them as guaranteed facts if they conflict with the user's current data.",
    "Prioritize current user-provided data over vault knowledge.",
    "Cite which entries support each recommendation or finding.",
    "Do not invent missing details.",
    "---",
  ];

  entries.forEach((e, i) => {
    lines.push(`Entry ${i + 1}:`);
    lines.push(`  Title: ${e.title}`);
    lines.push(`  Category: ${e.category}`);
    if (e.department) lines.push(`  Department: ${e.department}`);
    lines.push(`  Summary: ${e.summary}`);
    if (e.chunkPreview) {
      lines.push(`  Relevant excerpt:`);
      lines.push(`    ${e.chunkPreview.replace(/\n/g, "\n    ")}`);
    }
    lines.push(`  Source reference: ${e.sourceRef}`);
    if (i < entries.length - 1) {
      lines.push("---");
    }
  });

  return lines.join("\n");
}

// ── logKnowledgeUsage ─────────────────────────────────────────────────────────

export async function logKnowledgeUsage(event: KnowledgeUsageEvent): Promise<void> {
  try {
    // Validate integer arrays before the typed insert.
    const safeEntryIds = event.selectedEntryIds.filter((id) => Number.isInteger(id) && id > 0);
    const safeVersions = event.selectedEntryVersions.filter((v) => Number.isInteger(v) && v >= 0);
    await db.insert(knowledgeUsageEventsTable).values({
      userId: event.userId,
      query: event.query.slice(0, 500),
      reportType: event.reportType,
      selectedEntryIds: safeEntryIds,
      selectedEntryVersions: safeVersions,
      entryCount: event.entryCount,
    });
  } catch (err) {
    logger.warn({ err }, "vault-knowledge: failed to log usage event (non-fatal)");
  }
}
