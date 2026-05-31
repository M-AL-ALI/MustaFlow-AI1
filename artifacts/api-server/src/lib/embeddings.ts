// ─────────────────────────────────────────────────────────────────────────────
// Embeddings helper — generate AI embeddings for Knowledge Vault entries and
// compute cosine similarity for semantic ranking.
//
// Uses the OpenAI embeddings API directly (not the Replit AI proxy, which does
// not support POST /embeddings). Requires OPENAI_API_KEY server-side secret.
//
// All calls propagate errors — callers must handle failures explicitly and must
// NOT mark entries as indexed when embedding generation fails.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger";

/** Model used for all Knowledge Vault embeddings. 1536-dimensional. */
export const EMBEDDING_MODEL = "text-embedding-3-small";

/** Dimensions produced by text-embedding-3-small. */
const EMBEDDING_DIMENSIONS = 1536;

/** Cap input length so we never blow past the model's 8k-token limit. */
const MAX_INPUT_CHARS = 8000;

/** Base URL for the OpenAI embeddings API (direct, not proxied). */
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

/** Max retry attempts on 429 rate limit responses. */
const MAX_RETRIES = 3;
/** Base backoff in ms for exponential retry (doubles each attempt). */
const BASE_BACKOFF_MS = 1000;

// ── Provider configuration check ─────────────────────────────────────────────

/**
 * Returned when the embedding provider is not configured or misconfigured.
 * Callers should surface this as a user-visible error, not a silent skip.
 */
export class EmbeddingProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}

/**
 * Returned when the OpenAI API returns a non-200 response.
 * Includes the HTTP status so callers can handle 429 rate limits separately.
 */
export class EmbeddingApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "EmbeddingApiError";
  }
}

/** Validate that OPENAI_API_KEY is present at module load time. */
function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key.trim().length === 0) {
    throw new EmbeddingProviderError(
      "Embedding provider is not configured. Please add OPENAI_API_KEY.",
    );
  }
  return key;
}

// ── Core embedding call ───────────────────────────────────────────────────────

/**
 * Generate an embedding vector for a piece of text via the OpenAI embeddings
 * API (direct, bypassing the Replit AI proxy which does not support embeddings).
 *
 * Throws EmbeddingProviderError if OPENAI_API_KEY is absent.
 * Throws EmbeddingApiError on non-200 responses (including 429 rate limits).
 * Throws Error on unexpected network/parse failures.
 *
 * NEVER returns null — callers must catch and record failures explicitly.
 * Query text and chunk text are NOT logged (privacy requirement).
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = getApiKey(); // throws EmbeddingProviderError if missing

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("Cannot embed empty text");
  }

  const input = trimmed.length > MAX_INPUT_CHARS ? trimmed.slice(0, MAX_INPUT_CHARS) : trimmed;

  let lastError: EmbeddingApiError | Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input,
        dimensions: EMBEDDING_DIMENSIONS,
      }),
    });

    if (response.ok) {
      let body: { data?: { embedding?: number[] }[] };
      try {
        body = (await response.json()) as { data?: { embedding?: number[] }[] };
      } catch {
        throw new Error("OpenAI embeddings API returned non-JSON response");
      }

      const vec = body.data?.[0]?.embedding;
      if (!vec || vec.length === 0) {
        throw new Error("OpenAI embeddings API returned empty embedding vector");
      }
      if (vec.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `OpenAI embeddings API returned unexpected dimension: ${vec.length} (expected ${EMBEDDING_DIMENSIONS})`,
        );
      }
      return vec;
    }

    // Log only status + model + attempt — never the input text
    logger.warn(
      { status: response.status, model: EMBEDDING_MODEL, attempt },
      "vault-embedding: OpenAI embeddings API returned non-200",
    );

    // 429 rate limit — retry with exponential backoff
    if (response.status === 429 && attempt < MAX_RETRIES) {
      // Honour Retry-After header if present, otherwise use exponential backoff
      const retryAfterHeader = response.headers.get("retry-after");
      const backoffMs = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) * 1000
        : BASE_BACKOFF_MS * Math.pow(2, attempt);
      logger.info(
        { attempt, backoffMs },
        "vault-embedding: rate limited by OpenAI — retrying after backoff",
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      lastError = new EmbeddingApiError(
        `OpenAI embeddings API rate limited (attempt ${attempt + 1})`,
        429,
      );
      continue;
    }

    // Non-retryable error (400, 401, 500, etc.)
    throw new EmbeddingApiError(
      `OpenAI embeddings API error: HTTP ${response.status}`,
      response.status,
    );
  }

  // Exhausted retries
  throw (
    lastError ??
    new EmbeddingApiError("OpenAI embeddings API rate limit exceeded after retries", 429)
  );
}

// ── Similarity ────────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two equal-length vectors. Returns 0 for
 * mismatched/empty inputs so unusable embeddings score as "no signal".
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Text preparation ──────────────────────────────────────────────────────────

/**
 * Build the canonical text representation of a knowledge entry that we embed.
 * Matches the text we score TF-IDF against, so both ranking paths see the same content.
 */
export function buildEmbeddingInput(title: string, content: string, tags?: string | null): string {
  return [title, content, tags ?? ""].filter(Boolean).join("\n");
}
