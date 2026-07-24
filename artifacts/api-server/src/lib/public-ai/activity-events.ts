/**
 * Ora live activity trace — server-side emitter.
 *
 * Wraps the existing SSE channel with a small, safe lifecycle for structured
 * `{ type: "activity", phase, tool, text }` events (the typed extension of the
 * legacy `status` narration event — same stream, no second channel):
 *
 *  - `start` may be emitted repeatedly for the same tool (repo analysis
 *    narrates several steps: "Reading model-router.ts…", "Searching for…").
 *  - exactly ONE terminal `ok`/`fail` is emitted per started tool — duplicate
 *    terminals and terminals for tools that never started are ignored.
 *  - a failing write can never break the response stream (fire-and-forget).
 *
 * All human copy defaults to the shared wording map in @workspace/ora-contracts
 * so website and mobile show identical text. Never pass provider names, model
 * ids, stack traces, or absolute filesystem paths as custom text.
 */
import {
  oraActivityStep,
  type OraActivityEvent,
  type OraActivityStep,
  type OraActivityTool,
} from "@workspace/ora-contracts";

export interface OraActivityEmitter {
  /** Emit a `start` (or narration-update) step for a tool. */
  start(tool: OraActivityTool, text?: string): void;
  /** Emit the successful terminal step. No-op unless the tool is open. */
  ok(tool: OraActivityTool, text?: string): void;
  /** Emit the failure terminal step. No-op unless the tool is open. */
  fail(tool: OraActivityTool, text?: string): void;
  /** Everything emitted so far, in order (used by tests and diagnostics). */
  emitted(): OraActivityStep[];
}

/**
 * Create an emitter that forwards each activity event to `write` (typically
 * `(ev) => writeSSE(res, ev)`). Write failures are swallowed — activity is
 * fire-and-forget and must never take down the answer stream.
 */
export function createOraActivityEmitter(
  write: (event: OraActivityEvent) => void,
): OraActivityEmitter {
  const open = new Set<OraActivityTool>();
  const log: OraActivityStep[] = [];

  const emit = (tool: OraActivityTool, phase: OraActivityStep["phase"], text?: string): void => {
    const step = oraActivityStep(tool, phase, text);
    log.push(step);
    try {
      write({ type: "activity", ...step });
    } catch {
      // Fire-and-forget: a broken socket/serializer must never kill the stream.
    }
  };

  return {
    start(tool, text) {
      open.add(tool);
      emit(tool, "start", text);
    },
    ok(tool, text) {
      if (!open.delete(tool)) return;
      emit(tool, "ok", text);
    },
    fail(tool, text) {
      if (!open.delete(tool)) return;
      emit(tool, "fail", text);
    },
    emitted() {
      return [...log];
    },
  };
}

/**
 * Run one tool call inside the start → ok/fail lifecycle. On failure the
 * `fail` step is emitted FIRST (honest "tried and failed" line), then the
 * error is rethrown so the caller's existing graceful-degradation path runs —
 * the wrapper narrates, it never swallows or converts errors.
 */
export async function withOraActivity<T>(
  emitter: OraActivityEmitter,
  tool: OraActivityTool,
  fn: () => Promise<T>,
  texts?: { start?: string; ok?: string | ((result: T) => string); fail?: string },
): Promise<T> {
  emitter.start(tool, texts?.start);
  try {
    const result = await fn();
    emitter.ok(tool, typeof texts?.ok === "function" ? texts.ok(result) : texts?.ok);
    return result;
  } catch (err) {
    emitter.fail(tool, texts?.fail);
    throw err;
  }
}
