// ─────────────────────────────────────────────────────────────────────────────
// Embeddings helper — generate AI embeddings for Knowledge Vault entries and
// compute cosine similarity for semantic ranking.
//
// All calls are best-effort: on failure, callers fall back to TF-IDF ranking.
// ─────────────────────────────────────────────────────────────────────────────

import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger";

/** Model used for all Knowledge Vault embeddings. 1536-dimensional. */
export const EMBEDDING_MODEL = "text-embedding-3-small";

/** Cap input length so we never blow past the model's 8k-token limit. */
const MAX_INPUT_CHARS = 8000;

/**
 * Generate an embedding vector for a piece of text via the OpenAI embeddings API.
 * Returns null on any failure so callers can gracefully fall back to TF-IDF.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    const input = trimmed.length > MAX_INPUT_CHARS ? trimmed.slice(0, MAX_INPUT_CHARS) : trimmed;
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input,
    });
    const vec = response.data[0]?.embedding;
    if (!vec || vec.length === 0) return null;
    return vec as number[];
  } catch (err) {
    logger.warn({ err }, "Failed to generate embedding — caller should fall back");
    return null;
  }
}

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

/**
 * Build the canonical text representation of a knowledge entry that we embed.
 * Matches the text we score TF-IDF against, so both ranking paths see the same content.
 */
export function buildEmbeddingInput(title: string, content: string, tags?: string | null): string {
  return [title, content, tags ?? ""].filter(Boolean).join("\n");
}
