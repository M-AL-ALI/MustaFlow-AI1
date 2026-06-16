import type { Response } from "express";

/**
 * SSE event shapes emitted by /api/public-ai/chat/stream.
 *
 * start  — headers flushed, stream open; lets the client know the connection
 *          is established before the first AI token arrives. Carries optional
 *          `conversationId` so the client can correlate stream events to the
 *          persisted conversation row.
 * token  — incremental text fragment streamed token-by-token from the AI
 *          provider. Field is `text` (not `delta`) for readability.
 * status — specialist tool is running (file-gen, image-gen, search); no tokens
 *          follow for that branch (client falls back to /chat).
 * done   — stream complete; carries the full metadata set equivalent to the
 *          non-streaming /api/public-ai/chat JSON response.
 * error  — unrecoverable error that occurred after SSE headers were already
 *          flushed. `code` is a machine-readable category; `message` is
 *          human-readable. The client distinguishes pre-first-token errors
 *          (silent /chat fallback) from post-first-token errors (partial text
 *          already displayed; show a cut-off notice).
 */
export type OraStreamEvent =
  | { type: "start"; conversationId?: string; messageId?: string }
  | { type: "token"; text: string }
  | { type: "status"; label: string }
  | { type: "done"; payload: OraStreamDonePayload }
  | { type: "error"; code: string; message: string };

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
   * token fragments via its streaming API. False would indicate a simulated
   * chunk approach. Included in every done event so callers can benchmark /
   * log the difference between real and fallback streaming.
   */
  isRealStreaming: boolean;
}

/**
 * Write one Server-Sent Events frame to the response and flush immediately.
 *
 * Format: `event: <type>\ndata: <json>\n\n`  (RFC 8895 / WHATWG spec).
 * The `event:` field lets EventSource and raw readers dispatch by type;
 * the type is also embedded in the JSON payload for redundant compatibility.
 *
 * `X-Accel-Buffering: no` and `Cache-Control: no-cache, no-transform` are set
 * on the response headers upstream (before flushHeaders) so nginx and CDN
 * edge nodes do not buffer the byte stream. The explicit `.flush()` call here
 * ensures `express-compression` (if active) emits the chunk immediately.
 */
export function writeSSE(res: Response, event: OraStreamEvent): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
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
