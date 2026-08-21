import { ZERO_RUN_LOOP_PHASE_EVENT_TYPE } from "@workspace/ora-contracts";

export const HIDDEN_ZERO_TIMELINE_EVENT_TYPES = [
  "loop:step",
  ZERO_RUN_LOOP_PHASE_EVENT_TYPE,
] as const;

const HIDDEN_EVENT_TYPES: ReadonlySet<string> = new Set(HIDDEN_ZERO_TIMELINE_EVENT_TYPES);

export function isUserVisibleZeroTimelineEventType(eventType: string): boolean {
  return !HIDDEN_EVENT_TYPES.has(eventType);
}

/**
 * @dormantExport
 * No production consumer exists as of the inert-export registry anchor. This becomes reachable
 * when a timeline surface filters a complete event collection through the shared helper; current
 * rendering calls the singular predicate for each event.
 */
export function filterUserVisibleZeroTimelineEvents<T extends { eventType: string }>(
  events: readonly T[],
): T[] {
  return events.filter((event) => isUserVisibleZeroTimelineEventType(event.eventType));
}
