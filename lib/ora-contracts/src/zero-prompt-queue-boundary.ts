export const ZERO_PROMPT_QUEUE_BOUNDARY_SEMANTICS = "zero-prompt-queue-safe-boundaries-v1" as const;

export const ZERO_RUN_LOOP_PHASE_EVENT_TYPE = "loop:phase" as const;

export const ZERO_PROMPT_QUEUE_MAX_ITEMS = 50 as const;
export const ZERO_PROMPT_QUEUE_MAX_TEXT_CHARS = 10_000 as const;

export const ZERO_PROMPT_QUEUE_RUN_PHASES = [
  "between_steps",
  "createChatCompletion",
  "parallel_tool_batch",
  "serial_tool_call",
  "executeSingleFileWrite",
  "executeBatchFileWrite",
  "finalize_check",
  "auto_check",
  "post_loop_check",
  "e2e_smoke",
  "e2e_auto_fix",
  "project_files_commit",
  "runPostWriteMigrationSync",
  "production_publish",
] as const;

export const ZERO_PROMPT_QUEUE_LANDING_DECISIONS = ["lands_now", "lands_later"] as const;

export const ZERO_PROMPT_QUEUE_BOUNDARY_ERROR_CODES = [
  "queue_boundary_phase_invalid",
  "queue_boundary_item_not_queued",
  "queue_boundary_position_invalid",
] as const;

export const ZERO_PROMPT_QUEUE_UNKNOWN_PHASE = "UNKNOWN" as const;

export type ZeroPromptQueueRunPhase = (typeof ZERO_PROMPT_QUEUE_RUN_PHASES)[number];
export type ZeroPromptQueueObservedPhase =
  | ZeroPromptQueueRunPhase
  | typeof ZERO_PROMPT_QUEUE_UNKNOWN_PHASE;
export type ZeroPromptQueueLandingDecision = (typeof ZERO_PROMPT_QUEUE_LANDING_DECISIONS)[number];
export type ZeroPromptQueueBoundaryErrorCode =
  (typeof ZERO_PROMPT_QUEUE_BOUNDARY_ERROR_CODES)[number];

export type ZeroPromptQueueBoundaryRule = {
  phase: ZeroPromptQueueRunPhase;
  safeLanding: boolean;
  nextSafeBoundary: "between_steps";
};

export type ZeroPromptQueueLanding = {
  semantics: typeof ZERO_PROMPT_QUEUE_BOUNDARY_SEMANTICS;
  itemId: string;
  position: number;
  currentPhase: ZeroPromptQueueRunPhase;
  decision: ZeroPromptQueueLandingDecision;
  landingPhase: "between_steps";
};

export const ZERO_PROMPT_QUEUE_PHASE_RULES: readonly ZeroPromptQueueBoundaryRule[] =
  ZERO_PROMPT_QUEUE_RUN_PHASES.map((phase) => ({
    phase,
    safeLanding: phase === "between_steps",
    nextSafeBoundary: "between_steps",
  }));

export type ZeroRunLoopPhaseEvent = {
  semantics: typeof ZERO_PROMPT_QUEUE_BOUNDARY_SEMANTICS;
  phase: ZeroPromptQueueRunPhase;
};

const RUN_PHASE_SET: ReadonlySet<string> = new Set(ZERO_PROMPT_QUEUE_RUN_PHASES);

/** Validate persisted `loop:phase` messages without inferring from display copy. */
export function parseZeroRunLoopPhaseEvent(message: unknown): ZeroPromptQueueObservedPhase {
  if (typeof message !== "string") return ZERO_PROMPT_QUEUE_UNKNOWN_PHASE;
  try {
    const candidate = JSON.parse(message) as Partial<ZeroRunLoopPhaseEvent>;
    if (
      candidate.semantics !== ZERO_PROMPT_QUEUE_BOUNDARY_SEMANTICS ||
      typeof candidate.phase !== "string" ||
      !RUN_PHASE_SET.has(candidate.phase)
    ) {
      return ZERO_PROMPT_QUEUE_UNKNOWN_PHASE;
    }
    return candidate.phase as ZeroPromptQueueRunPhase;
  } catch {
    return ZERO_PROMPT_QUEUE_UNKNOWN_PHASE;
  }
}

export class ZeroPromptQueueBoundaryError extends Error {
  readonly name = "ZeroPromptQueueBoundaryError";

  constructor(readonly code: ZeroPromptQueueBoundaryErrorCode) {
    super(code);
  }
}
