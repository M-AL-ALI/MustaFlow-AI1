import type { ZeroPromptQueueItem } from "./zero-prompt-queue-contract";
import {
  ZERO_PROMPT_QUEUE_BOUNDARY_SEMANTICS,
  ZERO_PROMPT_QUEUE_RUN_PHASES,
  ZeroPromptQueueBoundaryError,
  type ZeroPromptQueueBoundaryRule,
  type ZeroPromptQueueLanding,
  type ZeroPromptQueueRunPhase,
} from "./zero-prompt-queue-boundary-contract";

const SAFE_BOUNDARY = "between_steps" as const;

export const ZERO_PROMPT_QUEUE_PHASE_RULES: readonly ZeroPromptQueueBoundaryRule[] =
  ZERO_PROMPT_QUEUE_RUN_PHASES.map((phase) => ({
    phase,
    safeLanding: phase === SAFE_BOUNDARY,
    nextSafeBoundary: SAFE_BOUNDARY,
  }));

const RULE_BY_PHASE: ReadonlyMap<ZeroPromptQueueRunPhase, ZeroPromptQueueBoundaryRule> = new Map(
  ZERO_PROMPT_QUEUE_PHASE_RULES.map((rule) => [rule.phase, rule]),
);

function requirePhase(phase: unknown): ZeroPromptQueueBoundaryRule {
  if (typeof phase !== "string") {
    throw new ZeroPromptQueueBoundaryError("queue_boundary_phase_invalid");
  }
  const rule = RULE_BY_PHASE.get(phase as ZeroPromptQueueRunPhase);
  if (!rule) throw new ZeroPromptQueueBoundaryError("queue_boundary_phase_invalid");
  return rule;
}

function orderedQueuedItems(items: readonly ZeroPromptQueueItem[]): readonly ZeroPromptQueueItem[] {
  const seenPositions = new Set<number>();
  for (const item of items) {
    if (item.state !== "queued") {
      throw new ZeroPromptQueueBoundaryError("queue_boundary_item_not_queued");
    }
    if (!Number.isInteger(item.position) || item.position < 1 || seenPositions.has(item.position)) {
      throw new ZeroPromptQueueBoundaryError("queue_boundary_position_invalid");
    }
    seenPositions.add(item.position);
  }
  return [...items].sort(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id),
  );
}

export function planPromptQueueLandings(input: {
  currentPhase: unknown;
  items: readonly ZeroPromptQueueItem[];
}): readonly ZeroPromptQueueLanding[] {
  const rule = requirePhase(input.currentPhase);
  return orderedQueuedItems(input.items).map((item) => ({
    semantics: ZERO_PROMPT_QUEUE_BOUNDARY_SEMANTICS,
    itemId: item.id,
    position: item.position,
    currentPhase: rule.phase,
    decision: rule.safeLanding ? "lands_now" : "lands_later",
    landingPhase: rule.nextSafeBoundary,
  }));
}
