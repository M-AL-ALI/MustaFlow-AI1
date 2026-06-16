import type { Response } from "express";

/**
 * SSE event shapes emitted by /api/public-ai/chat/stream.
 *
 * token  — incremental text delta streamed token-by-token from the AI provider.
 * status — specialist tool is running (file-gen, image-gen, search); no tokens
 *          follow for that branch (client falls back to /chat).
 * done   — stream complete; carries the full metadata set equivalent to the
 *          non-streaming /api/public-ai/chat JSON response.
 * error  — unrecoverable error that occurred after SSE headers were already
 *          flushed; the client should surface this as a chat error.
 */
export type OraStreamEvent =
  | { type: "token"; delta: string }
  | { type: "status"; label: string }
  | { type: "done"; payload: OraStreamDonePayload }
  | { type: "error"; message: string };

export interface OraStreamDonePayload {
  reply: string;
  suggestions?: string[];
  memorySaveCandidate?: string;
  memorySaveCandidateConfidence?: "high" | "low";
  memorySaveCandidateSensitive?: boolean;
  conversationSummary?: string;
  memoriesUsed?: Array<{ id: number; title: string }>;
  videos?: Array<{ url: string; title?: string; thumbnailUrl?: string }>;
  mode: "instant" | "deep";
  msgCount: number;
  msgLimit: number;
  imageCount?: number;
  imageLimit?: number;
  resetsAt?: string | null;
  windowHours?: number;
  /**
   * True when the upstream AI provider delivered the reply as real incremental
   * token deltas via its streaming API. False would indicate a simulated chunk
   * approach. Included in every done event so callers can benchmark / log the
   * difference.
   */
  isRealStreaming: boolean;
}

/**
 * Write one Server-Sent Events data line to the response and flush immediately.
 * Flushing is critical: without it, buffering middleware (e.g. express-compression)
 * may batch multiple writes before emitting, destroying the token-by-token UX.
 */
export function writeSSE(res: Response, event: OraStreamEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
  const r = res as Response & { flush?: () => void };
  r.flush?.();
}

/**
 * True when the provider supports real token-level streaming. All four
 * configured providers (openai, anthropic, deepseek, gemini) stream tokens
 * natively via their respective streaming APIs.
 */
export function isRealProviderStreaming(provider: string): boolean {
  return (
    provider === "openai" ||
    provider === "anthropic" ||
    provider === "deepseek" ||
    provider === "gemini"
  );
}

/**
 * Combine multiple AbortSignals into one that aborts when ANY source signal
 * aborts. Useful for merging a client-disconnect signal with a per-request
 * timeout signal.
 */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort(sig.reason);
      break;
    }
    sig.addEventListener("abort", () => controller.abort(sig.reason), { once: true });
  }
  return controller.signal;
}
