import {
  ZERO_PROMPT_QUEUE_BOUNDARY_SEMANTICS,
  ZERO_PROMPT_QUEUE_RUN_PHASES,
  ZERO_RUN_LOOP_PHASE_EVENT_TYPE,
  type ZeroPromptQueueRunPhase,
} from "./zero-prompt-queue-boundary-contract";

export { ZERO_RUN_LOOP_PHASE_EVENT_TYPE } from "./zero-prompt-queue-boundary-contract";

/**
 * Phase observations normally persist in a single local database call. A 250 ms
 * ceiling preserves ordering in that normal case while keeping eighteen stalled
 * observations below five seconds of cumulative delay in the pathological case.
 */
export const ZERO_RUN_LOOP_PHASE_EMIT_TIMEOUT_MS = 250;

export type ZeroRunLoopEmittablePhase = Exclude<ZeroPromptQueueRunPhase, "production_publish">;

export const ZERO_RUN_LOOP_EMITTABLE_PHASES = ZERO_PROMPT_QUEUE_RUN_PHASES.filter(
  (phase): phase is ZeroRunLoopEmittablePhase => phase !== "production_publish",
);

export type ZeroRunLoopPhaseEventSink = (
  eventType: string,
  message: string,
) => Promise<void> | void;

export type ZeroRunLoopPhaseEvent = {
  semantics: typeof ZERO_PROMPT_QUEUE_BOUNDARY_SEMANTICS;
  phase: ZeroRunLoopEmittablePhase;
};

export function serializeZeroRunLoopPhase(phase: ZeroRunLoopEmittablePhase): string {
  return JSON.stringify({
    semantics: ZERO_PROMPT_QUEUE_BOUNDARY_SEMANTICS,
    phase,
  } satisfies ZeroRunLoopPhaseEvent);
}

/** Best-effort observation only: phase telemetry must never alter run-loop control flow. */
export async function emitZeroRunLoopPhase(
  sink: ZeroRunLoopPhaseEventSink,
  phase: ZeroRunLoopEmittablePhase,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const delivery = Promise.resolve(
      sink(ZERO_RUN_LOOP_PHASE_EVENT_TYPE, serializeZeroRunLoopPhase(phase)),
    );
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, ZERO_RUN_LOOP_PHASE_EMIT_TIMEOUT_MS);
      if (typeof timeout === "object" && "unref" in timeout) timeout.unref();
    });

    await Promise.race([delivery, deadline]);
  } catch {
    // Existing task execution remains authoritative if observation delivery fails.
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
