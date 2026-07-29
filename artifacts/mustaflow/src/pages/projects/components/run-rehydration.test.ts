import { describe, expect, it } from "vitest";
import {
  isRehydratableTaskStatus,
  parseRunLoopProgress,
  selectRehydratableTaskId,
} from "./run-rehydration";

describe("run refresh rehydration", () => {
  it("selects a real in-flight task and ignores newer queued or terminal rows", () => {
    expect(
      selectRehydratableTaskId([
        { id: 14, status: "queued" },
        { id: 13, status: "completed" },
        { id: 12, status: "building" },
      ]),
    ).toBe(12);
  });

  it("rehydrates a task paused for an existing inline question", () => {
    expect(isRehydratableTaskStatus("needs_approval")).toBe(true);
    expect(isRehydratableTaskStatus("canceled")).toBe(false);
    expect(isRehydratableTaskStatus("cancelled")).toBe(false);
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
