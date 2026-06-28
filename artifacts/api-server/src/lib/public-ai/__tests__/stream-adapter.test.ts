/**
 * Unit tests for streamOraMessage (stream-adapter.ts).
 *
 * Product decision (TTFT audit + UX restore):
 *   Real streaming tokens (small deltas < 200 chars) and large proxy-buffered
 *   chunks (≥ 200 chars) BOTH flow through simulateChunkStream — small-delta
 *   groups are flushed on the first 2-word accumulation (improved TTFT) with
 *   the smooth 50 ms word-group cadence restored.
 *
 *   • Small deltas → 2-word groups sent through simulateChunkStream;
 *     usedSimulatedChunks stays false (flag tracks large-chunk path).
 *   • Large deltas (≥ 200 chars) → simulateChunkStream on full buffer;
 *     usedSimulatedChunks becomes true.
 *   • Mixed stream (small deltas then one large chunk) → reply is lossless,
 *     usedSimulatedChunks: true.
 *   • metrics event carries correct usedSimulatedChunks + providerDeltaCount.
 *   • Pending buffer is flushed after the provider loop ends.
 *   • Pre-first-token error → yields { type: "error", firstTokenSent: false }.
 *   • Post-first-token error → yields { type: "error", firstTokenSent: true }.
 *   • AbortSignal mid-stream causes generator to return early.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { streamOraMessage, withTimeout, type OraStreamProviderEvent } from "../stream-adapter";

// ---------------------------------------------------------------------------
// Mock streamChatCompletion so tests never hit a real API.
// ---------------------------------------------------------------------------

const streamChatCompletionMock = vi.hoisted(() => vi.fn());

vi.mock("../../ai-providers", () => ({
  streamChatCompletion: streamChatCompletionMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A never-aborting signal, suitable for most tests. */
function neverSignal(): AbortSignal {
  return new AbortController().signal;
}

/** Collect all events from the generator into an array. */
async function collect(gen: AsyncGenerator<OraStreamProviderEvent>): Promise<OraStreamProviderEvent[]> {
  const out: OraStreamProviderEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** Minimal silent logger for StreamOraParams. */
const silentLogger = { warn: vi.fn() };

/** A single candidate (no fallback needed for most tests). */
const ONE_CANDIDATE = [{ provider: "openai" as const, model: "gpt-5-mini" }];

/** Large string (≥ 200 chars) that triggers simulation. */
const LARGE_CHUNK = "word ".repeat(50); // 250 chars, 50 words

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Small deltas — real-time word-group emission, no simulation
// ---------------------------------------------------------------------------

describe("small deltas (< 200 chars each)", () => {
  it("emits a token event for every 2-word group that accumulates in the buffer", async () => {
    streamChatCompletionMock.mockImplementation(async function* () {
      yield "Hello ";
      yield "world ";
      yield "how ";
      yield "are ";
      yield "you";
    });

    const events = await collect(
      streamOraMessage({
        candidates: ONE_CANDIDATE,
        messages: [],
        maxTokens: 512,
        signal: neverSignal(),
        logger: silentLogger,
      }),
    );

    const tokenEvents = events.filter((e) => e.type === "token");
    // Accumulated text must be lossless.
    const joined = tokenEvents.map((e) => (e as { type: "token"; text: string }).text).join("");
    expect(joined).toBe("Hello world how are you");
    // Must have produced at least 2 discrete token events (incremental delivery).
    expect(tokenEvents.length).toBeGreaterThanOrEqual(2);
  });

  it("sets usedSimulatedChunks: false in the metrics event", async () => {
    streamChatCompletionMock.mockImplementation(async function* () {
      yield "fast ";
      yield "real ";
      yield "tokens";
    });

    const events = await collect(
      streamOraMessage({
        candidates: ONE_CANDIDATE,
        messages: [],
        maxTokens: 512,
        signal: neverSignal(),
        logger: silentLogger,
      }),
    );

    const metrics = events.find((e) => e.type === "metrics") as
      | { type: "metrics"; usedSimulatedChunks: boolean; providerDeltaCount: number }
      | undefined;
    expect(metrics).toBeDefined();
    expect(metrics!.usedSimulatedChunks).toBe(false);
    expect(metrics!.providerDeltaCount).toBe(3);
  });

  it("flushes the trailing pending buffer even if it holds fewer than 2 words", async () => {
    // 3 tokens: "one two" groups → emit, then "three" is trailing flush.
    streamChatCompletionMock.mockImplementation(async function* () {
      yield "one ";
      yield "two ";
      yield "three";
    });

    const events = await collect(
      streamOraMessage({
        candidates: ONE_CANDIDATE,
        messages: [],
        maxTokens: 512,
        signal: neverSignal(),
        logger: silentLogger,
      }),
    );

    const text = events
      .filter((e) => e.type === "token")
      .map((e) => (e as { type: "token"; text: string }).text)
      .join("");
    expect(text).toBe("one two three");
  });

  it("emits metrics before done", async () => {
    streamChatCompletionMock.mockImplementation(async function* () {
      yield "ping pong";
    });

    const events = await collect(
      streamOraMessage({
        candidates: ONE_CANDIDATE,
        messages: [],
        maxTokens: 512,
        signal: neverSignal(),
        logger: silentLogger,
      }),
    );

    const types = events.map((e) => e.type);
    const metricsIdx = types.indexOf("metrics");
    const doneIdx = types.indexOf("done");
    expect(metricsIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(-1);
    expect(metricsIdx).toBeLessThan(doneIdx);
  });
});

// ---------------------------------------------------------------------------
// 2. Large delta (≥ 200 chars) — simulation fallback
// ---------------------------------------------------------------------------

describe("large delta (≥ 200 chars) — simulation fallback", () => {
  it("sets usedSimulatedChunks: true when a single delta is large", async () => {
    streamChatCompletionMock.mockImplementation(async function* () {
      yield LARGE_CHUNK;
    });

    const events = await collect(
      streamOraMessage({
        candidates: ONE_CANDIDATE,
        messages: [],
        maxTokens: 512,
        signal: neverSignal(),
        logger: silentLogger,
      }),
    );

    const metrics = events.find((e) => e.type === "metrics") as
      | { type: "metrics"; usedSimulatedChunks: boolean; providerDeltaCount: number }
      | undefined;
    expect(metrics).toBeDefined();
    expect(metrics!.usedSimulatedChunks).toBe(true);
    expect(metrics!.providerDeltaCount).toBe(1);
  });

  it("produces multiple token events for a large single chunk (word-by-word simulation)", async () => {
    // 50 words at 2 words/group → ~25 simulated token events.
    streamChatCompletionMock.mockImplementation(async function* () {
      yield LARGE_CHUNK;
    });

    const events = await collect(
      streamOraMessage({
        candidates: ONE_CANDIDATE,
        messages: [],
        maxTokens: 512,
        signal: neverSignal(),
        logger: silentLogger,
      }),
    );

    const tokenEvents = events.filter((e) => e.type === "token");
    expect(tokenEvents.length).toBeGreaterThanOrEqual(10);
  });

  it("preserves the full text losslessly through simulation", async () => {
    const input = "alpha ".repeat(60); // 360 chars, 60 words
    streamChatCompletionMock.mockImplementation(async function* () {
      yield input;
    });

    const events = await collect(
      streamOraMessage({
        candidates: ONE_CANDIDATE,
        messages: [],
        maxTokens: 512,
        signal: neverSignal(),
        logger: silentLogger,
      }),
    );

    const joined = events
      .filter((e) => e.type === "token")
      .map((e) => (e as { type: "token"; text: string }).text)
      .join("");
    expect(joined).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// 3. Mixed stream — small deltas then a large chunk
// ---------------------------------------------------------------------------

describe("mixed stream (real tokens then a large buffered chunk)", () => {
  it("marks usedSimulatedChunks: true and preserves full text", async () => {
    const smallPart = "Hello world ";    // 2 words, triggers a real-time emit
    const largePart = "echo ".repeat(60); // 300 chars, triggers simulation

    streamChatCompletionMock.mockImplementation(async function* () {
      yield "Hello ";
      yield "world ";  // after 2nd small delta: pendingBuffer="Hello world " → emit "Hello world "
      yield largePart; // large delta: pending="" + largePart → simulation
    });

    const events = await collect(
      streamOraMessage({
        candidates: ONE_CANDIDATE,
        messages: [],
        maxTokens: 512,
        signal: neverSignal(),
        logger: silentLogger,
      }),
    );

    const tokenText = events
      .filter((e) => e.type === "token")
      .map((e) => (e as { type: "token"; text: string }).text)
      .join("");

    // Must reconstruct full original content.
    expect(tokenText).toBe(smallPart + largePart);

    const metrics = events.find((e) => e.type === "metrics") as
      | { type: "metrics"; usedSimulatedChunks: boolean; providerDeltaCount: number }
      | undefined;
    expect(metrics?.usedSimulatedChunks).toBe(true);
    expect(metrics?.providerDeltaCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 4. Provider counts in metrics
// ---------------------------------------------------------------------------

describe("metrics.providerDeltaCount", () => {
  it("counts every provider delta regardless of size", async () => {
    streamChatCompletionMock.mockImplementation(async function* () {
      for (let i = 0; i < 7; i++) yield `word${i} `;
    });

    const events = await collect(
      streamOraMessage({
        candidates: ONE_CANDIDATE,
        messages: [],
        maxTokens: 512,
        signal: neverSignal(),
        logger: silentLogger,
      }),
    );

    const metrics = events.find((e) => e.type === "metrics") as
      | { type: "metrics"; providerDeltaCount: number }
      | undefined;
    expect(metrics?.providerDeltaCount).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 5. Error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  it("pre-first-token provider error causes the generator to throw (no accumulated text)", async () => {
    // Only one candidate; throws before any yield.
    streamChatCompletionMock.mockImplementation(async function* () {
      throw new Error("provider down");
      yield ""; // unreachable — satisfies TS
    });

    const events = await collect(
      streamOraMessage({
        candidates: ONE_CANDIDATE,
        messages: [],
        maxTokens: 512,
        signal: neverSignal(),
        logger: silentLogger,
      }),
    );

    // With one candidate and pre-first-token failure, the generator yields
    // { type: "error", firstTokenSent: false }.
    const errorEvent = events.find((e) => e.type === "error") as
      | { type: "error"; firstTokenSent: boolean }
      | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.firstTokenSent).toBe(false);
  });

  it("post-first-token provider error yields error with firstTokenSent: true", async () => {
    // Yields enough to trigger a 2-word emit, then throws.
    streamChatCompletionMock.mockImplementation(async function* () {
      yield "first second "; // 2 words → real-time emit; firstTokenSent set
      throw new Error("mid-stream failure");
    });

    const events = await collect(
      streamOraMessage({
        candidates: ONE_CANDIDATE,
        messages: [],
        maxTokens: 512,
        signal: neverSignal(),
        logger: silentLogger,
      }),
    );

    const tokenEvents = events.filter((e) => e.type === "token");
    expect(tokenEvents.length).toBeGreaterThanOrEqual(1);

    const errorEvent = events.find((e) => e.type === "error") as
      | { type: "error"; firstTokenSent: boolean }
      | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.firstTokenSent).toBe(true);
  });

  it("with two candidates, first-candidate failure falls through to second", async () => {
    let callCount = 0;
    streamChatCompletionMock.mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        throw new Error("first candidate failed");
        yield ""; // unreachable
      }
      yield "fallback reply";
    });

    const events = await collect(
      streamOraMessage({
        candidates: [
          { provider: "openai" as const, model: "gpt-5-mini" },
          { provider: "anthropic" as const, model: "claude-3-haiku" },
        ],
        messages: [],
        maxTokens: 512,
        signal: neverSignal(),
        logger: silentLogger,
      }),
    );

    expect(callCount).toBe(2);
    const text = events
      .filter((e) => e.type === "token")
      .map((e) => (e as { type: "token"; text: string }).text)
      .join("");
    expect(text).toBe("fallback reply");

    // Fallback candidate sets usedFallback: true.
    const candidateEvents = events.filter((e) => e.type === "candidate") as Array<{
      type: "candidate";
      usedFallback: boolean;
    }>;
    expect(candidateEvents.length).toBe(2);
    expect(candidateEvents[0]!.usedFallback).toBe(false);
    expect(candidateEvents[1]!.usedFallback).toBe(true);

    // Stream succeeded — done event must be present.
    expect(events.some((e) => e.type === "done")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. AbortSignal — mid-stream early termination
// ---------------------------------------------------------------------------

describe("AbortSignal", () => {
  it("returns early when signal is aborted before provider yields any delta", async () => {
    const controller = new AbortController();
    controller.abort();

    // Generator would normally emit tokens, but abort fires first.
    streamChatCompletionMock.mockImplementation(async function* () {
      // Pause briefly so abort can be detected at the top of the for-await loop.
      await new Promise<void>((r) => setTimeout(r, 10));
      yield "should not arrive";
    });

    const events = await collect(
      streamOraMessage({
        candidates: ONE_CANDIDATE,
        messages: [],
        maxTokens: 512,
        signal: controller.signal,
        logger: silentLogger,
      }),
    );

    // No token events should have been emitted.
    expect(events.filter((e) => e.type === "token")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Event ordering: candidate → tokens → metrics → done
// ---------------------------------------------------------------------------

describe("event ordering", () => {
  it("emits candidate before any token, metrics before done", async () => {
    streamChatCompletionMock.mockImplementation(async function* () {
      yield "alpha beta gamma";
    });

    const events = await collect(
      streamOraMessage({
        candidates: ONE_CANDIDATE,
        messages: [],
        maxTokens: 512,
        signal: neverSignal(),
        logger: silentLogger,
      }),
    );

    const types = events.map((e) => e.type);
    const candidateIdx = types.indexOf("candidate");
    const firstTokenIdx = types.indexOf("token");
    const metricsIdx = types.indexOf("metrics");
    const doneIdx = types.indexOf("done");

    expect(candidateIdx).toBeLessThan(firstTokenIdx);
    expect(firstTokenIdx).toBeLessThan(metricsIdx);
    expect(metricsIdx).toBeLessThan(doneIdx);
    // Exactly one metrics and one done.
    expect(types.filter((t) => t === "metrics")).toHaveLength(1);
    expect(types.filter((t) => t === "done")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 8. withTimeout — deadline racing
// ---------------------------------------------------------------------------

describe("withTimeout", () => {
  it("resolves with the promise value when the promise wins the race", async () => {
    const fast = Promise.resolve(42);
    const result = await withTimeout(fast, 1000, 0);
    expect(result).toBe(42);
  });

  it("resolves with the fallback value when the deadline fires first", async () => {
    // A promise that never resolves — the 1 ms deadline fires first.
    const never = new Promise<number>(() => undefined);
    const result = await withTimeout(never, 1, -1);
    expect(result).toBe(-1);
  });

  it("works with non-numeric fallback types", async () => {
    const never = new Promise<string>(() => undefined);
    const result = await withTimeout(never, 1, "default");
    expect(result).toBe("default");
  });

  it("resolves with the promise when it wins against a 0ms deadline", async () => {
    // Microtask promise resolves synchronously in the same tick.
    const micro = Promise.resolve("fast");
    // 0ms deadline uses setTimeout which yields to the microtask queue first.
    const result = await withTimeout(micro, 0, "slow");
    expect(result).toBe("fast");
  });
});
