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
  | { type: "metrics"; usedSimulatedChunks: boolean; providerDeltaCount: number }
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
 * Always accumulate all provider chunks before simulating. This guarantees
 * word-by-word streaming regardless of whether the AI proxy delivers one large
 * chunk or many small real tokens — both cases are handled identically by
 * running the full accumulated text through simulateChunkStream.
 *
 * The old per-chunk threshold approach broke when the Gemini integration proxy
 * started returning real streaming tokens (each < 25 chars): those small chunks
 * bypassed simulateChunkStream entirely, fired in rapid succession, and the
 * Replit dev proxy or React 18 automatic batching delivered them all at once.
 */

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
 * Byte length at or above which a single provider delta is treated as a
 * proxy-buffered chunk rather than a real streaming token. Large single deltas
 * indicate the upstream proxy accumulated the full completion and delivered it
 * all at once; in that case we fall back to simulateChunkStream on the pending
 * buffer so the user still sees word-by-word animation.
 */
const LARGE_CHUNK_THRESHOLD = 200;

/**
 * Split the full accumulated provider response into word-group sub-tokens with
 * short delays between emissions, producing a word-by-word streaming effect.
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

      // Real-time word-group streaming with large-chunk simulation fallback.
      //
      // For each provider delta:
      //   • Small delta (< LARGE_CHUNK_THRESHOLD chars) — real streaming token.
      //     Accumulate into pendingBuffer; emit a 2-word group immediately once
      //     the buffer holds at least SIMULATE_WORDS_PER_GROUP words. No
      //     artificial 50 ms delay — the provider's natural token rate provides
      //     pacing, and the client-side 55 ms render gate prevents visual
      //     batching of fast-arriving frames.
      //   • Large delta (≥ LARGE_CHUNK_THRESHOLD chars) — proxy-buffered chunk.
      //     Run simulateChunkStream on the current pendingBuffer (which already
      //     includes the large delta) so the user still sees word-by-word
      //     animation even when the upstream proxy delivers the full completion
      //     in one piece.
      //
      // Re-emitting already-sent text is avoided: simulation always operates on
      // pendingBuffer (not-yet-emitted text), which is reset to "" after each
      // flush. accumulated tracks the full response for error-recovery.
      let accumulated = "";
      let pendingBuffer = "";    // text received but not yet emitted
      let providerDeltaCount = 0;
      let usedSimulatedChunks = false;
      let providerMidStreamErr: Error | null = null;

      try {
        for await (const delta of gen) {
          if (signal.aborted) return;
          accumulated += delta;
          pendingBuffer += delta;
          providerDeltaCount++;

          if (delta.length >= LARGE_CHUNK_THRESHOLD) {
            // Large buffered chunk — simulate the entire pending buffer
            // (which already includes this large delta) word-by-word.
            usedSimulatedChunks = true;
            for await (const piece of simulateChunkStream(pendingBuffer, signal)) {
              if (signal.aborted) return;
              firstTokenSent = true;
              yield { type: "token", text: piece };
            }
            pendingBuffer = "";
          } else {
            // Real streaming token — emit a 2-word group as soon as ready.
            const wordCount = (pendingBuffer.match(/\S+/g) ?? []).length;
            if (wordCount >= SIMULATE_WORDS_PER_GROUP) {
              firstTokenSent = true;
              yield { type: "token", text: pendingBuffer };
              pendingBuffer = "";
              // Yield to the event loop so abort signals are checked promptly
              // even under a very fast provider.
              await new Promise<void>((r) => setTimeout(r, 0));
            }
          }
        }
      } catch (err) {
        providerMidStreamErr = err as Error;
      }

      // Nothing received at all — rethrow so the outer catch retries the next
      // candidate (or surfaces stream_failed if no candidates remain).
      if (providerMidStreamErr && !accumulated) {
        throw providerMidStreamErr;
      }

      // Flush any text still waiting in the pending buffer.
      if (pendingBuffer && !signal.aborted) {
        if (usedSimulatedChunks) {
          // Already in simulation mode — keep consistent word-by-word pacing.
          for await (const piece of simulateChunkStream(pendingBuffer, signal)) {
            if (signal.aborted) return;
            firstTokenSent = true;
            yield { type: "token", text: piece };
          }
        } else {
          // Real streaming — emit the trailing word group immediately.
          firstTokenSent = true;
          yield { type: "token", text: pendingBuffer };
        }
      }

      // Partial content received — report as interrupted so the client shows
      // the partial reply + an error notice rather than silence.
      if (providerMidStreamErr) {
        yield { type: "error", firstTokenSent: true, err: providerMidStreamErr };
        return;
      }

      yield { type: "metrics", usedSimulatedChunks, providerDeltaCount };
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
