import { describe, expect, it } from "vitest";
import {
  isRehydratableTaskStatus,
  parseRunLoopProgress,
  selectPendingRunTaskId,
  selectRehydratableTaskId,
} from "./run-rehydration";

describe("run refresh rehydration", () => {
  it("selects the newest real in-flight task and ignores terminal rows", () => {
    expect(
      selectRehydratableTaskId([
        { id: 14, status: "queued" },
        { id: 13, status: "completed" },
        { id: 12, status: "building" },
      ]),
    ).toBe(14);
  });

  it("rehydrates a task paused for an existing inline question", () => {
    expect(isRehydratableTaskStatus("answering")).toBe(true);
    expect(isRehydratableTaskStatus("needs_approval")).toBe(true);
    expect(isRehydratableTaskStatus("needs_review")).toBe(true);
    expect(isRehydratableTaskStatus("canceled")).toBe(false);
    expect(isRehydratableTaskStatus("cancelled")).toBe(false);
  });

  it("finds every newly polled run by id without comparing browser and server clocks", () => {
    const firstBaseline = new Set([40, 41]);
    expect(
      selectPendingRunTaskId(
        [
          { id: 42, status: "building" },
          { id: 41, status: "completed" },
          { id: 40, status: "completed" },
        ],
        firstBaseline,
      ),
    ).toBe(42);

    const secondBaseline = new Set([40, 41, 42]);
    expect(
      selectPendingRunTaskId(
        [
          { id: 43, status: "planning" },
          { id: 42, status: "completed" },
        ],
        secondBaseline,
      ),
    ).toBe(43);
  });

  it("does not attach a terminal or pre-existing task to the pending run", () => {
    expect(
      selectPendingRunTaskId(
        [
          { id: 45, status: "completed" },
          { id: 44, status: "building" },
        ],
        new Set([44]),
      ),
    ).toBeNull();
  });

  it("keeps background queue work out of the foreground activity stream", () => {
    expect(
      selectPendingRunTaskId(
        [
          { id: 46, status: "building", kind: "background" },
          { id: 45, status: "completed", kind: "main" },
        ],
        new Set([45]),
      ),
    ).toBeNull();
  });

  it("reads exact progress from the existing loop:step event", () => {
    expect(
      parseRunLoopProgress(
        "loop:step",
        JSON.stringify({
          stepIndex: 3,
          stepCap: 25,
          wallClockElapsedMs: 5000,
          wallClockBudgetMs: 600000,
        }),
      ),
    ).toEqual({ stepIndex: 3, stepCap: 25 });
  });

  it("rejects malformed or unrelated progress", () => {
    expect(parseRunLoopProgress("narration", '{"stepIndex":3,"stepCap":25}')).toBeNull();
    expect(parseRunLoopProgress("loop:step", '{"stepIndex":0,"stepCap":25}')).toBeNull();
    expect(parseRunLoopProgress("loop:step", "not-json")).toBeNull();
  });
});
