import type { ZeroPromptQueueItem } from "./zero-prompt-queue-contract";
import {
  ZERO_PROMPT_QUEUE_BOUNDARY_SEMANTICS,
  ZERO_PROMPT_QUEUE_PHASE_RULES,
  ZeroPromptQueueBoundaryError,
  type ZeroPromptQueueBoundaryRule,
  type ZeroPromptQueueLanding,
  type ZeroPromptQueueRunPhase,
} from "./zero-prompt-queue-boundary-contract";

export { ZERO_PROMPT_QUEUE_PHASE_RULES } from "./zero-prompt-queue-boundary-contract";

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

/**
 * @dormantExport
 * No production consumer exists as of the inert-export registry anchor. This becomes reachable
 * when run-loop or UI control flow asks this planner for per-item landing decisions instead of
 * reading the phase rules directly.
 */
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
