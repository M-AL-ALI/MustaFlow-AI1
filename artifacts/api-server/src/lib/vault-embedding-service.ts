// ─────────────────────────────────────────────────────────────────────────────
// Phase 8B-1: Knowledge Vault Embedding Infrastructure
//
// Manual-only. No RAG, no prompt injection, no automatic learning.
// Chunks vault entries, generates embeddings, stores them per-chunk.
// Embeddings are used for semantic retrieval in Phase 8B-2.
//
// Correctness invariants:
//  - An entry is counted "indexed" only when ≥1 non-null vector was stored.
//  - An entry is counted "failed" when embedding generation throws or returns
//    no valid vector for every chunk that needed re-embedding.
//  - vault_embeddings rows with embedding IS NULL are never inserted.
//  - Chunk text and query text are never logged (privacy requirement).
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  vaultEntriesTable,
  vaultEmbeddingsTable,
  VAULT_CHUNK_TARGET_CHARS,
  VAULT_EMBEDDING_MODEL,
  VAULT_MAX_CHUNKS_PER_ENTRY,
  VAULT_MAX_ENTRY_CHARS,
  type VaultEntry,
} from "@workspace/db";
import { generateEmbedding, EmbeddingProviderError, EmbeddingApiError } from "./embeddings";
import { detectSensitiveContent, sanitizeText } from "./vault-sanitizer";
import { logger } from "./logger";

// ── Constants ─────────────────────────────────────────────────────────────────
/** Max entries per reindex-all run. */
const MAX_ENTRIES_PER_BATCH = 100;
/** Max reindex-all calls per user per hour. */
const REINDEX_ALL_HOURLY_LIMIT = 5;
const REINDEX_ALL_WINDOW_MS = 60 * 60 * 1000;

// ── In-memory rate limiter for reindex-all ────────────────────────────────────
const reindexAllThrottle = new Map<string, number[]>();

function checkReindexAllRateLimit(userId: string): {
  allowed: boolean;
  retryAfterSec: number;
  remaining: number;
} {
  const now = Date.now();
  const calls = (reindexAllThrottle.get(userId) ?? []).filter(
    (t) => now - t < REINDEX_ALL_WINDOW_MS,
  );
  if (calls.length >= REINDEX_ALL_HOURLY_LIMIT) {
    const oldest = calls[0] ?? now;
    const retryAfterSec = Math.ceil((oldest + REINDEX_ALL_WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfterSec, remaining: 0 };
  }
  calls.push(now);
  reindexAllThrottle.set(userId, calls);
  return { allowed: true, retryAfterSec: 0, remaining: REINDEX_ALL_HOURLY_LIMIT - calls.length };
}

// ── Chunking ─────────────────────────────────────────────────────────────────

/**
 * Build the canonical text for a vault entry chunk.
 * Metadata prefix + content body, truncated to VAULT_MAX_ENTRY_CHARS.
 */
function buildEntryText(entry: VaultEntry): string {
  const metaParts = [
    `Title: ${entry.title}`,
    `Category: ${entry.category}`,
    entry.subcategory ? `Subcategory: ${entry.subcategory}` : null,
    entry.department ? `Department: ${entry.department}` : null,
    entry.tags.length > 0 ? `Tags: ${entry.tags.join(", ")}` : null,
    `Summary: ${entry.summary}`,
  ]
    .filter(Boolean)
    .join("\n");

  const full = `${metaParts}\n\nContent:\n${entry.content}`;
  return full.slice(0, VAULT_MAX_ENTRY_CHARS);
}

/**
 * Split entry text into chunks of ≤ VAULT_CHUNK_TARGET_CHARS characters,
 * splitting at natural text boundaries (double newline → newline → space).
 * Returns at most VAULT_MAX_CHUNKS_PER_ENTRY chunks.
 */
function splitIntoChunks(text: string): string[] {
  if (text.length <= VAULT_CHUNK_TARGET_CHARS) return [text];

  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > 0 && chunks.length < VAULT_MAX_CHUNKS_PER_ENTRY) {
    if (remaining.length <= VAULT_CHUNK_TARGET_CHARS) {
      chunks.push(remaining);
      break;
    }
    const window = VAULT_CHUNK_TARGET_CHARS;
    const half = Math.floor(window * 0.5);
    const para = remaining.lastIndexOf("\n\n", window);
    const nl = remaining.lastIndexOf("\n", window);
    const sp = remaining.lastIndexOf(" ", window);
    let splitAt = para >= half ? para : nl >= half ? nl : sp > 0 ? sp : window;
    splitAt = Math.max(1, splitAt);
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  return chunks.filter((c) => c.length > 0);
}

/** SHA-256 hex of the chunk text (first 64 chars = 32 bytes). */
function hashChunk(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// ── Status ────────────────────────────────────────────────────────────────────

export type EmbeddingStatus = "not_indexed" | "indexed" | "out_of_date";

export interface VaultEmbeddingStatusResult {
  entryId: number;
  status: EmbeddingStatus;
  chunkCount: number;
  embeddingModel: string | null;
  sourceVersion: number | null;
  updatedAt: string | null;
}

export async function getEmbeddingStatus(
  entryId: number,
  userId: string,
): Promise<VaultEmbeddingStatusResult> {
  const base: VaultEmbeddingStatusResult = {
    entryId,
    status: "not_indexed",
    chunkCount: 0,
    embeddingModel: null,
    sourceVersion: null,
    updatedAt: null,
  };

  // Verify ownership
  const [entry] = await db
    .select({ id: vaultEntriesTable.id, version: vaultEntriesTable.version })
    .from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.id, entryId), eq(vaultEntriesTable.userId, userId)));
  if (!entry) return base;

  // Only count rows that have a real (non-null) embedding vector
  const rows = await db
    .select({
      chunkCount: sql<number>`count(*)::int`,
      maxSourceVersion: sql<number>`max(source_version)::int`,
      embeddingModel: vaultEmbeddingsTable.embeddingModel,
      maxUpdatedAt: sql<string>`max(updated_at)::text`,
    })
    .from(vaultEmbeddingsTable)
    .where(
      and(
        eq(vaultEmbeddingsTable.entryId, entryId),
        eq(vaultEmbeddingsTable.userId, userId),
        sql`${vaultEmbeddingsTable.embedding} IS NOT NULL`,
      ),
    )
    .groupBy(vaultEmbeddingsTable.embeddingModel);

  if (rows.length === 0) return base;

  const row = rows[0]!;
  const chunkCount = row.chunkCount;
  const sourceVersion = row.maxSourceVersion;
  const status: EmbeddingStatus = sourceVersion === entry.version ? "indexed" : "out_of_date";

  return {
    entryId,
    status,
    chunkCount,
    embeddingModel: row.embeddingModel,
    sourceVersion,
    updatedAt: row.maxUpdatedAt ?? null,
  };
}

// ── Reindex single entry ──────────────────────────────────────────────────────

export interface ReindexResult {
  entryId: number;
  chunksUpserted: number;
  chunksSkipped: number;
  chunksDeleted: number;
  status: EmbeddingStatus;
  error?: string;
}

export async function reindexVaultEntry(entryId: number, userId: string): Promise<ReindexResult> {
  const base: ReindexResult = {
    entryId,
    chunksUpserted: 0,
    chunksSkipped: 0,
    chunksDeleted: 0,
    status: "not_indexed",
  };

  // Load entry with ownership check
  const [entry] = await db
    .select()
    .from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.id, entryId), eq(vaultEntriesTable.userId, userId)));

  if (!entry) {
    return { ...base, error: "Entry not found or access denied" };
  }

  // Sanitize before embedding — never send secrets to the model
  const combinedText = `${entry.title} ${entry.summary} ${entry.content}`;
  const sensitiveIssue = detectSensitiveContent(combinedText);
  if (sensitiveIssue) {
    return {
      ...base,
      error: `Sensitive content detected — embedding blocked: ${sensitiveIssue}`,
    };
  }

  const safeEntry: VaultEntry = {
    ...entry,
    summary: sanitizeText(entry.summary),
    content: sanitizeText(entry.content),
    title: sanitizeText(entry.title),
  };

  // Build text, chunk it, hash each chunk
  const fullText = buildEntryText(safeEntry);
  const textChunks = splitIntoChunks(fullText);

  // Load existing chunks for this entry to detect stale ones
  const existingChunks = await db
    .select({
      chunkIndex: vaultEmbeddingsTable.chunkIndex,
      chunkHash: vaultEmbeddingsTable.chunkHash,
    })
    .from(vaultEmbeddingsTable)
    .where(and(eq(vaultEmbeddingsTable.entryId, entryId), eq(vaultEmbeddingsTable.userId, userId)));

  const existingByIndex = new Map(existingChunks.map((r) => [r.chunkIndex, r.chunkHash]));
  const newIndexSet = new Set(textChunks.map((_, i) => i));

  let chunksUpserted = 0;
  let chunksSkipped = 0;
  let chunksFailed = 0;
  let providerError: string | undefined;

  for (let i = 0; i < textChunks.length; i++) {
    const chunkText = textChunks[i]!;
    const chunkHash = hashChunk(chunkText);
    const existingHash = existingByIndex.get(i);

    if (existingHash === chunkHash) {
      // Hash unchanged — bump sourceVersion only (no re-embedding needed)
      chunksSkipped++;
      await db
        .update(vaultEmbeddingsTable)
        .set({ sourceVersion: entry.version, updatedAt: new Date() })
        .where(
          and(
            eq(vaultEmbeddingsTable.entryId, entryId),
            eq(vaultEmbeddingsTable.userId, userId),
            eq(vaultEmbeddingsTable.chunkIndex, i),
          ),
        );
      continue;
    }

    // Generate embedding for changed or new chunk — never silently skip on error
    let vec: number[];
    try {
      vec = await generateEmbedding(chunkText);
    } catch (err) {
      chunksFailed++;
      // Log only safe metadata — never log chunk text or query text
      if (err instanceof EmbeddingProviderError) {
        providerError = err.message;
        logger.warn(
          { entryId, chunkIndex: i, error: err.message },
          "vault-embedding: provider not configured",
        );
        // Provider missing — no point continuing; all chunks will fail
        break;
      } else if (err instanceof EmbeddingApiError) {
        logger.warn(
          { entryId, chunkIndex: i, status: err.statusCode },
          "vault-embedding: API error generating embedding",
        );
        // Continue to try remaining chunks on non-fatal API errors
        continue;
      } else {
        logger.warn(
          { entryId, chunkIndex: i, error: String(err) },
          "vault-embedding: unexpected error generating embedding",
        );
        continue;
      }
    }

    // Only insert rows with a real (non-null) embedding vector
    await db
      .insert(vaultEmbeddingsTable)
      .values({
        entryId,
        userId,
        chunkIndex: i,
        chunkText,
        chunkHash,
        embedding: vec,
        embeddingModel: VAULT_EMBEDDING_MODEL,
        sourceVersion: entry.version,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [vaultEmbeddingsTable.entryId, vaultEmbeddingsTable.chunkIndex],
        set: {
          chunkText,
          chunkHash,
          embedding: vec,
          embeddingModel: VAULT_EMBEDDING_MODEL,
          sourceVersion: entry.version,
          updatedAt: new Date(),
        },
      });

    chunksUpserted++;
  }

  // Delete stale chunks (indexes that no longer exist in current text)
  const staleIndexes = [...existingByIndex.keys()].filter((idx) => !newIndexSet.has(idx));
  let chunksDeleted = 0;
  if (staleIndexes.length > 0) {
    await db
      .delete(vaultEmbeddingsTable)
      .where(
        and(
          eq(vaultEmbeddingsTable.entryId, entryId),
          eq(vaultEmbeddingsTable.userId, userId),
          inArray(vaultEmbeddingsTable.chunkIndex, staleIndexes),
        ),
      );
    chunksDeleted = staleIndexes.length;
  }

  // If embedding failed for every chunk that needed (re-)embedding and none were
  // skipped (i.e. no pre-existing valid vectors), surface the error clearly.
  if (chunksFailed > 0 && chunksUpserted === 0) {
    const errorMsg =
      providerError ?? `Embedding generation failed for all ${chunksFailed} chunk(s)`;
    logger.warn(
      { entryId, chunksFailed, chunksSkipped },
      "vault-embedding: reindex failed — no vectors stored",
    );
    return { ...base, error: errorMsg };
  }

  const finalStatus = await getEmbeddingStatus(entryId, userId);

  logger.info(
    { entryId, chunksUpserted, chunksSkipped, chunksDeleted, status: finalStatus.status },
    "vault-embedding: reindex complete",
  );

  return {
    entryId,
    chunksUpserted,
    chunksSkipped,
    chunksDeleted,
    status: finalStatus.status,
  };
}

// ── Reindex all user entries ──────────────────────────────────────────────────

export interface ReindexAllResult {
  total: number;
  indexed: number;
  skipped: number;
  failed: number;
  rateLimited: boolean;
  retryAfterSec: number;
  remaining: number;
  providerError?: string;
}

export async function reindexAllVaultEntries(userId: string): Promise<ReindexAllResult> {
  const rateCheck = checkReindexAllRateLimit(userId);
  if (!rateCheck.allowed) {
    return {
      total: 0,
      indexed: 0,
      skipped: 0,
      failed: 0,
      rateLimited: true,
      retryAfterSec: rateCheck.retryAfterSec,
      remaining: 0,
    };
  }

  // Load up to MAX_ENTRIES_PER_BATCH active (non-archived) entries for this user
  const entries = await db
    .select({ id: vaultEntriesTable.id })
    .from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.userId, userId), sql`${vaultEntriesTable.archivedAt} IS NULL`))
    .limit(MAX_ENTRIES_PER_BATCH);

  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  let providerError: string | undefined;

  for (const { id } of entries) {
    try {
      const result = await reindexVaultEntry(id, userId);
      if (result.error) {
        failed++;
        // Capture provider error and abort early — all remaining entries will
        // fail with the same root cause
        if (result.error.includes("not configured") || result.error.includes("OPENAI_API_KEY")) {
          providerError = result.error;
          // Count remaining entries as failed too
          failed += entries.length - failed - indexed - skipped - 1;
          break;
        }
      } else if (result.chunksUpserted === 0 && result.chunksSkipped > 0) {
        // All chunks unchanged — already indexed, nothing to do
        skipped++;
      } else {
        indexed++;
      }
    } catch (err) {
      logger.warn({ entryId: id, error: String(err) }, "vault-embedding: reindex-all entry failed");
      failed++;
    }
  }

  return {
    total: entries.length,
    indexed,
    skipped,
    failed,
    rateLimited: false,
    retryAfterSec: 0,
    remaining: rateCheck.remaining,
    ...(providerError ? { providerError } : {}),
  };
}

// ── Delete embeddings ─────────────────────────────────────────────────────────

export async function deleteEmbeddingsForEntry(entryId: number, userId: string): Promise<void> {
  await db
    .delete(vaultEmbeddingsTable)
    .where(and(eq(vaultEmbeddingsTable.entryId, entryId), eq(vaultEmbeddingsTable.userId, userId)));
}
