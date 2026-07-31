import { describe, expect, it } from "vitest";
import type { NabuflowUsageEvent } from "@workspace/api-client-react";
import { filterUsageEventsForPreset } from "./usage-cycle-filter";

const event = (overrides: Partial<NabuflowUsageEvent>): NabuflowUsageEvent =>
  ({
    id: 1,
    cycleId: 77,
    orgId: null,
    projectId: 1,
    taskId: 1,
    source: "pipeline",
    engineMode: "lite",
    deepReasoning: false,
    credits: 13,
    includedCredits: 13,
    overageCredits: 0,
    overageUsdCents: 0,
    usdValueCents: 13,
    attribution: "personal",
    description: "Build",
    reversedAt: null,
    createdAt: "2026-07-31T16:22:00.000Z",
    ...overrides,
  }) as NabuflowUsageEvent;

describe("Usage current-cycle filtering", () => {
  it("uses the ledger cycle id instead of Test Clock wall time", () => {
    const events = [
      event({ id: 1, cycleId: 77, createdAt: "2026-07-31T16:22:00.000Z" }),
      event({ id: 2, cycleId: 78, createdAt: "2026-07-31T20:00:00.000Z" }),
    ];

    expect(
      filterUsageEventsForPreset(events, {
        preset: "current",
        currentCycleId: 77,
        start: new Date("2026-07-31T19:29:00.000Z"),
        end: new Date("2026-08-31T19:29:00.000Z"),
      }).map((row) => row.id),
    ).toEqual([1]);
  });

  it("keeps date-window filtering for last and custom ranges", () => {
    const events = [
      event({ id: 1, cycleId: 77, createdAt: "2026-06-30T12:00:00.000Z" }),
      event({ id: 2, cycleId: 77, createdAt: "2026-07-15T12:00:00.000Z" }),
    ];

    expect(
      filterUsageEventsForPreset(events, {
        preset: "custom",
        currentCycleId: 77,
        start: new Date("2026-07-01T00:00:00.000Z"),
        end: new Date("2026-08-01T00:00:00.000Z"),
      }).map((row) => row.id),
    ).toEqual([2]);
  });
});
