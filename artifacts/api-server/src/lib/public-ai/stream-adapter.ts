import type { Response } from "express";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Provider } from "../ai-provider-config";

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
  | { type: "status"; text: string }
  | { type: "done"; payload: OraStreamDonePayload }
  | { type: "error"; code: string; message: string; fallbackToken?: string };

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
  // Also call the underlying socket's cork/uncork to force a TCP flush when
  // compression is not active. This prevents Nagle-algorithm batching from
  // holding small SSE frames until the next write or ACK timeout.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sock = (res.socket ?? (res as any)._socket) as { uncork?: () => void } | null;
  if (sock?.uncork) sock.uncork();
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

/**
 * Provider-level event emitted by `streamOraMessage`. Separate from the
 * SSE-wire `OraStreamEvent` so the route can translate as needed.
 *
 * candidate — a new provider/model is being tried (route updates metadata).
 * token     — one incremental text fragment from the current provider.
 * done      — all tokens delivered; no error.
 * error     — streaming failed; `firstTokenSent` tells whether partial text
 *             was already forwarded so the route can choose code + refund.
 */
export type OraStreamProviderEvent =
  | { type: "candidate"; provider: string; model: string; usedFallback: boolean }
  | { type: "token"; text: string }
  | { type: "done" }
  | { type: "error"; firstTokenSent: boolean; err: Error };

export interface StreamOraParams {
  candidates: ReadonlyArray<{ provider: Provider; model: string }>;
  messages: ChatCompletionMessageParam[];
  maxTokens: number;
  /** Combined signal: merges client-disconnect + first-token timeout. */
  signal: AbortSignal;
  logger: { warn: (obj: object, msg: string) => void };
}

/**
 * Minimum character length of a provider chunk before we split it into
 * simulated word-group tokens. The Replit AI integrations proxy buffers the
 * full AI response and returns it as a single chunk regardless of the
 * `stream: true` flag sent to the provider. Chunks below this threshold are
 * small enough to emit as-is (they already feel incremental); larger chunks
 * are split into word groups with short delays so the user sees progressive
 * text delivery even though the underlying proxy is non-streaming.
 */
const SIMULATE_THRESHOLD_CHARS = 25;

/**
 * Number of words to group into each simulated token emission. 2 words per
 * group gives a natural word-by-word streaming feel without generating an
 * excessive number of SSE frames. Lower than 4 (the old default) so the
 * visual update frequency is doubled, making the streaming effect clearly
 * perceptible even for short responses.
 */
const SIMULATE_WORDS_PER_GROUP = 2;

/**
 * Milliseconds between simulated token emissions. 50 ms ≈ 20 visible text
 * updates per second — perceptibly progressive without appearing slow for
 * medium-length replies. Checked against the AbortSignal after each delay so
 * client disconnects are honoured promptly.
 *
 * At this rate a 60-word response streams over ~1500 ms; a 240-word response
 * over ~6000 ms — both clearly visible before the "done" event lands.
 */
const SIMULATE_DELAY_MS = 50;

/**
 * Split a large provider chunk into word-group sub-tokens with short delays
 * between emissions, simulating token-by-token streaming when the underlying
 * AI proxy returned the full response as a single chunk.
 *
 * Splitting is done at whitespace boundaries so words are never broken.
 * Each yielded string includes trailing whitespace from the original so the
 * concatenation of all groups equals the original text exactly.
 */
async function* simulateChunkStream(text: string, signal: AbortSignal): AsyncGenerator<string> {
  // Split preserving inter-word whitespace tokens so we can rebuild faithfully.
  const tokens = text.split(/(\s+)/);
  let group = "";
  let wordCount = 0;

  for (const tok of tokens) {
    if (signal.aborted) return;
    group += tok;
    // Count only non-whitespace tokens as "words".
    if (tok.trim().length > 0) wordCount++;

    if (wordCount >= SIMULATE_WORDS_PER_GROUP) {
      yield group;
      group = "";
      wordCount = 0;
      await new Promise<void>((resolve) => setTimeout(resolve, SIMULATE_DELAY_MS));
    }
  }
  // Flush any remaining text (last partial group).
  if (group && !signal.aborted) yield group;
}

/**
 * Provider-switch streaming adapter. Iterates the candidate chain and yields
 * `OraStreamProviderEvent` values so the route can handle SSE writing, session
 * accounting, and error recovery without embedding provider-switch logic inline.
 *
 * When a provider returns a large chunk in one piece (which happens when the
 * Replit AI integrations proxy buffers the full completion), `simulateChunkStream`
 * breaks it into word-group sub-tokens with short delays so the UI sees
 * progressive text delivery regardless of whether the upstream proxy truly
 * streams.
 *
 * Fallback semantics:
 * - If a candidate throws BEFORE the first token, log and try the next one.
 * - If a candidate throws AFTER the first token, emit `error` immediately —
 *   partial text has already been forwarded so switching providers is unsafe.
 * - If `signal` aborts mid-stream (client disconnect), return silently so the
 *   route can detect `abortController.signal.aborted` and close the response.
 */
export async function* streamOraMessage(
  params: StreamOraParams,
): AsyncGenerator<OraStreamProviderEvent> {
  const { candidates, messages, maxTokens, signal, logger } = params;
  // Dynamic import mirrors the pattern used in the non-streaming route and
  // ensures the vi.mock("../ai-providers") in tests intercepts correctly.
  const { streamChatCompletion } = await import("../ai-providers");

  let firstTokenSent = false;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const usedFallback = i > 0;
    yield {
      type: "candidate",
      provider: candidate.provider,
      model: candidate.model,
      usedFallback,
    };

    try {
      const gen = streamChatCompletion({
        provider: candidate.provider,
        model: candidate.model,
        messages,
        max_completion_tokens: maxTokens,
        signal,
        // Live conversational chat: prioritize a fast first token over Gemini's
        // multi-second silent "thinking" phase so streaming starts visibly
        // instead of sitting on an empty bubble. (Builder code-gen leaves this
        // off to keep full reasoning.)
        disableThinking: true,
      });

      for await (const delta of gen) {
        if (signal.aborted) return; // client disconnected mid-stream

        // When the AI proxy returns a large chunk in one piece, split it into
        // word groups with delays so the frontend sees progressive tokens.
        if (delta.length > SIMULATE_THRESHOLD_CHARS) {
          for await (const piece of simulateChunkStream(delta, signal)) {
            if (signal.aborted) return;
            firstTokenSent = true;
            yield { type: "token", text: piece };
          }
        } else {
          firstTokenSent = true;
          yield { type: "token", text: delta };
        }
      }

      yield { type: "done" };
      return;
    } catch (candidateErr) {
      if (firstTokenSent) {
        // Partial text already forwarded — do not switch providers.
        yield { type: "error", firstTokenSent: true, err: candidateErr as Error };
        return;
      }
      logger.warn(
        {
          component: "ora-chat-stream",
          provider: candidate.provider,
          model: candidate.model,
          attempt: i + 1,
          ofCandidates: candidates.length,
          err: candidateErr,
        },
        "Streaming candidate failed — trying next provider",
      );
      if (i === candidates.length - 1) {
        yield { type: "error", firstTokenSent: false, err: candidateErr as Error };
      }
    }
  }
}
