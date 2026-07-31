import type { NabuflowUsageEvent } from "@workspace/api-client-react";

export type UsageCyclePreset = "current" | "last" | "custom";

export function filterUsageEventsForPreset(
  events: NabuflowUsageEvent[],
  input: {
    preset: UsageCyclePreset;
    currentCycleId: number | null;
    start: Date;
    end: Date;
  },
): NabuflowUsageEvent[] {
  if (input.preset === "current" && input.currentCycleId != null) {
    return events.filter((event) => event.cycleId === input.currentCycleId);
  }

  const start = input.start.getTime();
  const end = input.end.getTime();
  return events.filter((event) => {
    if (!event.createdAt) return false;
    const createdAt = new Date(event.createdAt).getTime();
    return createdAt >= start && createdAt < end;
  });
}
