import { describe, expect, it } from "vitest";
import {
  filterUserVisibleZeroTimelineEvents,
  HIDDEN_ZERO_TIMELINE_EVENT_TYPES,
  isUserVisibleZeroTimelineEventType,
} from "./agent-timeline-event-visibility";

describe("Zero timeline event visibility", () => {
  it("keeps machine-only event types out of user-visible text", () => {
    const machineEvents = HIDDEN_ZERO_TIMELINE_EVENT_TYPES.map((eventType, index) => ({
      id: index + 1,
      eventType,
      message: JSON.stringify({ privateContract: true }),
    }));

    expect(filterUserVisibleZeroTimelineEvents(machineEvents)).toEqual([]);
    expect(HIDDEN_ZERO_TIMELINE_EVENT_TYPES.map(isUserVisibleZeroTimelineEventType)).toEqual([
      false,
      false,
    ]);
  });

  it("retains narration and ordinary tool events", () => {
    const events = [
      { eventType: "narration", message: "Working on your update." },
      { eventType: "tool_call", message: "{}" },
    ];

    expect(filterUserVisibleZeroTimelineEvents(events)).toEqual(events);
  });
});
