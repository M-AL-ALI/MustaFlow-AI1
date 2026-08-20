import {
  ZERO_PROMPT_QUEUE_BOUNDARY_SEMANTICS,
  ZERO_PROMPT_QUEUE_RUN_PHASES,
  type ZeroPromptQueueRunPhase,
} from "./zero-prompt-queue-boundary-contract";

export const ZERO_RUN_LOOP_PHASE_EVENT_TYPE = "loop:phase" as const;

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
  try {
    await sink(ZERO_RUN_LOOP_PHASE_EVENT_TYPE, serializeZeroRunLoopPhase(phase));
  } catch {
    // Existing task execution remains authoritative if observation delivery fails.
  }
}
