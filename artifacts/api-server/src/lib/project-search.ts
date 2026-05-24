/**
 * Project search — semantic, glob, and substring helpers used by the agentic
 * builder loop's smart-search tools (Task #534).
 *
 * Per-project embeddings live in `project_embeddings`. They are populated
 * lazily on the first `semantic_search` call and incrementally invalidated by
 * `invalidateFileEmbedding` / `invalidateProjectEmbeddings` after file mutations
 * (write_file, apply_patch, delete_file) and snapshot rollbacks.
 *
 * Embedding generation is best-effort: if the OpenAI call fails or pgvector
 * is unavailable, callers transparently fall back to in-memory cosine
 * similarity or a simple substring scan.
 */

import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  projectEmbeddingsTable,
  PROJECT_EMBEDDING_DIM,
  PROJECT_EMBEDDING_MODEL,
  type ProjectEmbedding,
} from "@workspace/db";
import { generateEmbedding, cosineSimilarity } from "./embeddings";
import { logger } from "./logger";

/** Max files we'll (re-)embed in a single semantic_search call. */
const MAX_FILES_PER_INDEX_PASS = 60;
/** Max characters of file content we feed into the embeddings model. */
const MAX_EMBED_CHARS = 6000;

export interface ProjectFileLike {
  path: string;
  content: string;
}

export interface SemanticHit {
  path: string;
  score: number;
  snippet: string;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function buildSnippet(content: string, query?: string): string {
  const trimmed = content.replace(/\s+/g, " ").trim();
  if (!query) return trimmed.slice(0, 200);
  const lower = trimmed.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return trimmed.slice(0, 200);
  const start = Math.max(0, idx - 60);
  return (start > 0 ? "…" : "") + trimmed.slice(start, start + 200);
}

function buildEmbeddingInput(path: string, content: string): string {
  // Path is semantically meaningful (e.g. "src/checkout.ts" hints at intent).
  const head = content.slice(0, MAX_EMBED_CHARS);
  return `path: ${path}\n\n${head}`;
}

function parseDbVector(raw: unknown): number[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as number[]) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Translate a glob pattern (`*`, `?`, `**`) into a RegExp anchored end-to-end.
 * Matches paths relative to the project root (no leading slash).
 */
export function globToRegex(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches across path separators
        re += ".*";
        i++;
        // swallow following slash so "src/**/file" matches "src/file"
        if (pattern[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === ".") {
      re += "\\.";
    } else if ("+()[]{}|^$\\".includes(c ?? "")) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}

export function matchGlob(pattern: string, paths: string[]): string[] {
  const re = globToRegex(pattern);
  return paths.filter((p) => re.test(p));
}

/** Drop one file's embedding row. Best-effort, non-fatal. */
export async function invalidateFileEmbedding(projectId: number, filePath: string): Promise<void> {
  try {
    await db
      .delete(projectEmbeddingsTable)
      .where(
        and(
          eq(projectEmbeddingsTable.projectId, projectId),
          eq(projectEmbeddingsTable.filePath, filePath),
        ),
      );
  } catch (err) {
    logger.debug({ err, projectId, filePath }, "project-search: invalidate failed (non-fatal)");
  }
}

/** Drop ALL embeddings for a project (used on snapshot rollback). */
export async function invalidateProjectEmbeddings(projectId: number): Promise<void> {
  try {
    await db.delete(projectEmbeddingsTable).where(eq(projectEmbeddingsTable.projectId, projectId));
  } catch (err) {
    logger.debug({ err, projectId }, "project-search: project invalidate failed (non-fatal)");
  }
}

/**
 * Ensure every supplied file has an up-to-date embedding row. Rows whose
 * content_hash matches the current file content are reused; stale or missing
 * rows are (re-)embedded up to MAX_FILES_PER_INDEX_PASS per call.
 *
 * Returns the freshest row set we could assemble — callers may receive fewer
 * rows than `files` if embeddings generation failed or was rate-limited.
 */
async function ensureIndex(
  projectId: number,
  files: ProjectFileLike[],
): Promise<Map<string, { vector: number[] | null; snippet: string }>> {
  const out = new Map<string, { vector: number[] | null; snippet: string }>();
  if (files.length === 0) return out;

  let existing: ProjectEmbedding[] = [];
  try {
    existing = await db
      .select()
      .from(projectEmbeddingsTable)
      .where(eq(projectEmbeddingsTable.projectId, projectId));
  } catch (err) {
    // Table might not exist yet (migration not run) — degrade gracefully.
    logger.warn({ err, projectId }, "project-search: read of embeddings table failed");
    return out;
  }

  const existingByPath = new Map(existing.map((r) => [r.filePath, r]));

  const stale: ProjectFileLike[] = [];
  for (const f of files) {
    const hash = hashContent(f.content);
    const row = existingByPath.get(f.path);
    if (row && row.contentHash === hash && row.model === PROJECT_EMBEDDING_MODEL) {
      out.set(f.path, {
        vector: parseDbVector(row.embedding),
        snippet: row.snippet,
      });
    } else {
      stale.push(f);
    }
  }

  // Bulk-prune rows for files that no longer exist in the project.
  const currentPaths = new Set(files.map((f) => f.path));
  const orphanedIds = existing.filter((r) => !currentPaths.has(r.filePath)).map((r) => r.id);
  if (orphanedIds.length > 0) {
    try {
      await db
        .delete(projectEmbeddingsTable)
        .where(inArray(projectEmbeddingsTable.id, orphanedIds));
    } catch (err) {
      logger.debug({ err, projectId }, "project-search: orphan prune failed (non-fatal)");
    }
  }

  // Re-embed stale entries up to the per-call budget so a huge initial index
  // doesn't time out the model's tool call. Subsequent calls finish the rest.
  const todo = stale.slice(0, MAX_FILES_PER_INDEX_PASS);
  for (const f of todo) {
    const hash = hashContent(f.content);
    const vector = await generateEmbedding(buildEmbeddingInput(f.path, f.content));
    const snippet = buildSnippet(f.content);
    try {
      if (vector && vector.length === PROJECT_EMBEDDING_DIM) {
        // Drizzle's pgvector binding accepts number[] directly.
        await db
          .insert(projectEmbeddingsTable)
          .values({
            projectId,
            filePath: f.path,
            contentHash: hash,
            model: PROJECT_EMBEDDING_MODEL,
            embedding: vector,
            snippet,
          })
          .onConflictDoUpdate({
            target: [projectEmbeddingsTable.projectId, projectEmbeddingsTable.filePath],
            set: {
              contentHash: hash,
              model: PROJECT_EMBEDDING_MODEL,
              embedding: vector,
              snippet,
              updatedAt: sql`now()`,
            },
          });
      }
    } catch (err) {
      logger.debug({ err, projectId, path: f.path }, "project-search: upsert failed (non-fatal)");
    }
    out.set(f.path, { vector, snippet });
  }

  // For stale files we couldn't get to this pass, expose a content-derived
  // snippet so substring fallback ranking still has something to show.
  for (const f of stale.slice(MAX_FILES_PER_INDEX_PASS)) {
    if (!out.has(f.path)) out.set(f.path, { vector: null, snippet: buildSnippet(f.content) });
  }
  return out;
}

/** Score files by substring frequency — fallback when no embeddings exist. */
function substringRank(query: string, files: ProjectFileLike[], topK: number): SemanticHit[] {
  const q = query.toLowerCase();
  const hits: SemanticHit[] = [];
  for (const f of files) {
    const lower = f.content.toLowerCase();
    let count = 0;
    let idx = lower.indexOf(q);
    while (idx !== -1 && count < 50) {
      count++;
      idx = lower.indexOf(q, idx + q.length);
    }
    if (count === 0 && !f.path.toLowerCase().includes(q)) continue;
    hits.push({
      path: f.path,
      score: count + (f.path.toLowerCase().includes(q) ? 1 : 0),
      snippet: buildSnippet(f.content, query),
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

/**
 * Top-k semantically relevant files for a natural-language query.
 *
 * Uses in-memory cosine similarity over the freshly-ensured per-project
 * embedding index. (pgvector is the durable store; we cosine-rank in
 * application code so the result includes per-file snippets without an extra
 * round-trip — and so the function works even when the table is empty or the
 * vector extension is unavailable.)
 */
export async function semanticSearch(
  projectId: number,
  query: string,
  files: ProjectFileLike[],
  topK = 8,
): Promise<SemanticHit[]> {
  const limit = Math.max(1, Math.min(topK, 20));
  if (files.length === 0) return [];

  const index = await ensureIndex(projectId, files);
  const queryVec = await generateEmbedding(query);

  if (!queryVec) {
    return substringRank(query, files, limit);
  }

  // Merge vector-scored files with a substring-ranked tail for files whose
  // embedding hasn't been generated yet (large first-time indexes exceed the
  // per-call re-embed budget). Cosine scores are in [-1, 1]; we map substring
  // hits into the same band by normalising into [0, 0.5] so any real cosine
  // hit outranks substring-only fallbacks but the fallbacks still surface.
  const scored: SemanticHit[] = [];
  const unembedded: ProjectFileLike[] = [];
  for (const f of files) {
    const entry = index.get(f.path);
    if (entry?.vector) {
      scored.push({
        path: f.path,
        score: cosineSimilarity(queryVec, entry.vector),
        snippet: entry.snippet || buildSnippet(f.content),
      });
    } else {
      unembedded.push(f);
    }
  }

  if (unembedded.length > 0) {
    const fallback = substringRank(query, unembedded, limit);
    const maxFallbackScore = fallback.reduce((m, h) => Math.max(m, h.score), 0);
    for (const hit of fallback) {
      scored.push({
        path: hit.path,
        score: maxFallbackScore > 0 ? (hit.score / maxFallbackScore) * 0.5 : 0,
        snippet: hit.snippet,
      });
    }
  }

  if (scored.length === 0) {
    return substringRank(query, files, limit);
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
