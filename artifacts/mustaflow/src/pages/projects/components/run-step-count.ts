export type RunStepEvent = {
  id: number;
  eventType: string;
};

/**
 * Canonical task steps are durable units of work, not every status or narration
 * line that describes them. Tool-loop iterations, QA actions, user prompts, and
 * the durable pipeline transitions below each contribute one event id.
 *
 * Keeping this definition independent from the bounded activity/narration rows
 * makes the count cumulative and reload-stable while those display rows remain
 * capped for a calm thread.
 */
const COUNTED_RUN_STEP_EVENT_TYPES = new Set([
  "queued",
  "loop:step",
  "agent_prompt",
  "qa_step",
  "check_deferred",
  "saving_version",
  "updating_preview",
  "qa_done",
]);

export type RunStepIdSet = Set<number>;

export function createRunStepIdSet(): RunStepIdSet {
  return new Set<number>();
}

export function addRunStepId(stepIds: RunStepIdSet, event: RunStepEvent): number {
  if (
    Number.isInteger(event.id) &&
    event.id >= 0 &&
    COUNTED_RUN_STEP_EVENT_TYPES.has(event.eventType.toLowerCase())
  ) {
    stepIds.add(event.id);
  }
  return stepIds.size;
}

export function buildRunStepIdSet(events: RunStepEvent[]): RunStepIdSet {
  const stepIds = createRunStepIdSet();
  for (const event of [...events].sort((left, right) => left.id - right.id)) {
    addRunStepId(stepIds, event);
  }
  return stepIds;
}
