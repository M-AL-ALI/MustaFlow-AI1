// ─────────────────────────────────────────────────────────────────────────────
// Phase 8B-2: Knowledge Vault Semantic Search
//
// Search-only. No RAG, no prompt injection, no AI answer generation,
// no automatic memory, no recommendations.
//
// The user's query is embedded via text-embedding-3-small.
// The resulting vector is compared against vault_embeddings (stored in Phase 8B-1).
// Only the authenticated user's embeddings are ever queried.
// Raw vectors are never returned to the client.
// ─────────────────────────────────────────────────────────────────────────────

import { db, VAULT_EMBEDDING_DIM } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { generateEmbedding } from "./embeddings";
import { logger } from "./logger";

// ── Constants ─────────────────────────────────────────────────────────────────
const SEMANTIC_SEARCH_HOURLY_LIMIT = 30;
const SEMANTIC_SEARCH_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
/** Characters of chunk text returned as a preview (no raw vector). */
const CHUNK_PREVIEW_CHARS = 300;

// ── Per-user rate limiter (in-memory, sliding window) ─────────────────────────
const searchThrottle = new Map<string, number[]>();

function checkRateLimit(userId: string): {
  allowed: boolean;
  retryAfterSec: number;
  remaining: number;
} {
  const now = Date.now();
  const calls = (searchThrottle.get(userId) ?? []).filter(
    (t) => now - t < SEMANTIC_SEARCH_WINDOW_MS,
  );
  if (calls.length >= SEMANTIC_SEARCH_HOURLY_LIMIT) {
    const oldest = calls[0] ?? now;
    return {
      allowed: false,
      retryAfterSec: Math.ceil((oldest + SEMANTIC_SEARCH_WINDOW_MS - now) / 1000),
      remaining: 0,
    };
  }
  calls.push(now);
  searchThrottle.set(userId, calls);
  return {
    allowed: true,
    retryAfterSec: 0,
    remaining: SEMANTIC_SEARCH_HOURLY_LIMIT - calls.length,
  };
}

/**
 * Validate and format an embedding vector as a pgvector literal.
 * All values are validated as finite floats before string interpolation.
 */
function toVectorLiteral(vec: number[]): string | null {
  if (vec.length !== VAULT_EMBEDDING_DIM) return null;
  for (const v of vec) {
    if (!Number.isFinite(v)) return null;
  }
  return `[${vec.join(",")}]`;
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface SemanticSearchParams {
  query: string;
  limit?: number;
  category?: string;
  department?: string;
  tags?: string[];
  status?: string;
  includeArchived?: boolean;
}

export interface SemanticSearchResult {
  entryId: number;
  title: string;
  category: string;
  department: string | null;
  summary: string;
  tags: string[];
  status: string;
  version: number;
  chunkIndex: number;
  /** First CHUNK_PREVIEW_CHARS characters of the best-matching chunk. No raw vector. */
  chunkPreview: string;
  /** Similarity score 0–100 (100 = identical). */
  similarityScore: number;
  updatedAt: string;
}

export interface SemanticSearchResponse {
  query: string;
  results: SemanticSearchResult[];
  rateLimited?: boolean;
  retryAfterSec?: number;
  remaining?: number;
  /** True when the user has no indexed embeddings at all. */
  noEmbeddingsExist?: boolean;
  /** True when the OpenAI embedding call failed. */
  embeddingError?: boolean;
}

// ── Main search function ──────────────────────────────────────────────────────

export async function semanticSearchVault(
  params: SemanticSearchParams,
  userId: string,
): Promise<SemanticSearchResponse> {
  const base: SemanticSearchResponse = { query: params.query, results: [] };

  // 1. Rate limit (per-user, 30 searches per hour)
  const rateCheck = checkRateLimit(userId);
  if (!rateCheck.allowed) {
    return {
      ...base,
      rateLimited: true,
      retryAfterSec: rateCheck.retryAfterSec,
      remaining: 0,
    };
  }

  const limit = Math.min(Math.max(1, params.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  // 2. Embed the user query. Only the query goes to the model —
  //    vault entry chunks were already embedded in Phase 8B-1.
  const queryVec = await generateEmbedding(params.query.slice(0, 1000));
  if (!queryVec) {
    logger.warn({ userId }, "vault-search: query embedding generation failed");
    return { ...base, embeddingError: true };
  }

  const vecLit = toVectorLiteral(queryVec);
  if (!vecLit) {
    logger.warn({ userId, dim: queryVec.length }, "vault-search: embedding dimension mismatch");
    return { ...base, embeddingError: true };
  }

  // 3. Build the entry-level WHERE clause (ownership always enforced first)
  const entryFilters: SQL[] = [sql`e.user_id = ${userId}`];
  if (!params.includeArchived) entryFilters.push(sql`e.archived_at IS NULL`);
  if (params.category) entryFilters.push(sql`e.category = ${params.category}`);
  if (params.department) entryFilters.push(sql`e.department = ${params.department}`);
  if (params.status) entryFilters.push(sql`e.status = ${params.status}`);
  if (params.tags && params.tags.length > 0) {
    // Any tag overlap: entry must share at least one tag with the requested list
    const tagArr = params.tags.map((t) => sql`${t}`);
    entryFilters.push(sql`e.tags && ARRAY[${sql.join(tagArr, sql`, `)}]::text[]`);
  }

  const entryWhere = sql.join(entryFilters, sql` AND `);

  // vecRaw is a safe raw SQL fragment — all values validated as finite floats above.
  const vecRaw = sql.raw(`'${vecLit}'::vector`);

  // 4. DISTINCT ON (entry_id): best chunk per entry (lowest cosine distance),
  //    joined back to vault_entries for metadata + filters,
  //    then globally re-ranked by distance ascending.
  //    Raw embeddings are never selected or returned.
  type Row = {
    entryId: number;
    chunkIndex: number;
    chunkText: string;
    similarityScore: number;
    title: string;
    category: string;
    department: string | null;
    summary: string;
    tags: string[];
    status: string;
    version: number;
    updatedAt: string;
  };

  let rows: Row[];
  try {
    const result = await db.execute<Row>(sql`
      SELECT
        best.entry_id    AS "entryId",
        best.chunk_index AS "chunkIndex",
        best.chunk_text  AS "chunkText",
        ROUND(CAST((1.0 - best.distance) * 100 AS numeric), 1)::float8 AS "similarityScore",
        e.title,
        e.category,
        e.department,
        e.summary,
        e.tags,
        e.status,
        e.version,
        e.updated_at::text AS "updatedAt"
      FROM (
        SELECT DISTINCT ON (ve.entry_id)
          ve.entry_id,
          ve.chunk_index,
          ve.chunk_text,
          ve.embedding <=> ${vecRaw} AS distance
        FROM vault_embeddings ve
        WHERE ve.user_id = ${userId}
          AND ve.embedding IS NOT NULL
        ORDER BY ve.entry_id, ve.embedding <=> ${vecRaw}
      ) best
      JOIN vault_entries e ON e.id = best.entry_id
      WHERE ${entryWhere}
      ORDER BY best.distance ASC
      LIMIT ${limit}
    `);
    rows = result.rows;
  } catch (err) {
    logger.error({ userId, err }, "vault-search: pgvector query error");
    return { ...base, embeddingError: true };
  }

  // 5. If no results, distinguish "no match" from "nothing indexed yet"
  if (rows.length === 0) {
    const countResult = await db.execute<{ cnt: number }>(sql`
      SELECT COUNT(*)::int AS cnt
      FROM vault_embeddings
      WHERE user_id = ${userId} AND embedding IS NOT NULL
    `);
    const cnt = countResult.rows[0]?.cnt ?? 0;
    if (cnt === 0) {
      return { ...base, noEmbeddingsExist: true };
    }
    return base;
  }

  // 6. Shape results — chunk preview truncated, score clamped, no raw vectors
  const results: SemanticSearchResult[] = rows.map((row) => ({
    entryId: row.entryId,
    title: row.title,
    category: row.category,
    department: row.department ?? null,
    summary: row.summary,
    tags: Array.isArray(row.tags) ? row.tags : [],
    status: row.status,
    version: row.version,
    chunkIndex: row.chunkIndex,
    chunkPreview: (row.chunkText ?? "").slice(0, CHUNK_PREVIEW_CHARS),
    similarityScore: Math.min(100, Math.max(0, Number(row.similarityScore) || 0)),
    updatedAt: row.updatedAt ?? new Date().toISOString(),
  }));

  logger.info(
    { userId, resultCount: results.length, remaining: rateCheck.remaining },
    "vault-search: semantic search complete",
  );

  return { query: params.query, results, remaining: rateCheck.remaining };
}
