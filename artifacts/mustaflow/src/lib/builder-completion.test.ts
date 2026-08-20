import { describe, expect, it } from "vitest";
import {
  getBuilderCheckpointLabel,
  getBuilderCompletionMessage,
  getBuilderDisplayStepCount,
  getBuilderTaskQueueLabel,
  getBuilderWarningCompletionMessage,
  STEP_CAP_COMPLETION_MESSAGE,
} from "./builder-completion";

describe("Builder completion messages", () => {
  it("never labels a step-cap task as a plain completed build", () => {
    expect(getBuilderCompletionMessage("step_cap")).toBe(STEP_CAP_COMPLETION_MESSAGE);
    expect(getBuilderCompletionMessage("step_cap")).not.toBe("Build complete");
  });

  it("preserves the normal finalized completion message", () => {
    expect(getBuilderCompletionMessage("finalized", "Build complete")).toBe("Build complete");
  });

  it("labels step-cap and finalized task queue chips honestly", () => {
    expect(getBuilderTaskQueueLabel("completed", "step_cap")).toBe("Completed at limit");
    expect(getBuilderTaskQueueLabel("completed", "finalized")).toBe("Completed");
  });

  it("preserves the legacy task queue label when completion kind is null", () => {
    expect(getBuilderTaskQueueLabel("completed", null)).toBe("completed");
  });

  it("renders capacity admission as a calm failure rather than a completed build", () => {
    expect(getBuilderCompletionMessage("admission_blocked")).toBe(
      "This build did not start because the account is already at its running-build limit",
    );
    expect(getBuilderTaskQueueLabel("failed", "admission_blocked")).toBe(
      "Not started — capacity reached",
    );
    expect(getBuilderCompletionMessage("admission_blocked")).not.toContain("complete");
  });

  it("renders an unavailable admission check as retryable failure copy", () => {
    expect(getBuilderCompletionMessage("admission_unavailable")).toContain(
      "capacity checks are temporarily unavailable",
    );
    expect(getBuilderTaskQueueLabel("failed", "admission_unavailable")).toBe(
      "Not started — try again",
    );
  });

  it("claims preview availability only when the preview actually updated", () => {
    expect(getBuilderWarningCompletionMessage("finalized", true)).toContain("preview available");
    expect(getBuilderWarningCompletionMessage("finalized", false)).toBe(
      "Build completed with warnings — validation not clean",
    );
    expect(getBuilderWarningCompletionMessage("finalized", false)).not.toContain("preview");
  });

  it("replaces a checkpoint's plain completion sentence with the shared step-cap disclosure", () => {
    const label =
      "**Initial React + Vite build**\nInitial build — 17 file(s) generated.\nBuilt 17 files via agentic loop.";

    const honestLabel = getBuilderCheckpointLabel(label, "step_cap");

    expect(honestLabel).toContain(STEP_CAP_COMPLETION_MESSAGE);
    expect(honestLabel).not.toContain("Built 17 files via agentic loop.");
  });

  it("leaves finalized and legacy checkpoint labels unchanged", () => {
    const label = "Initial build — 3 file(s) generated.\nBuilt 3 files via agentic loop.";
    expect(getBuilderCheckpointLabel(label, "finalized")).toBe(label);
    expect(getBuilderCheckpointLabel(label, null)).toBe(label);
  });

  it("uses the authoritative agent-loop count for a terminal build summary", () => {
    expect(
      getBuilderDisplayStepCount({
        isTerminal: true,
        agentLoopSteps: 25,
        eventStepCount: 34,
      }),
    ).toBe(25);
  });

  it("keeps event-count progress while a build is still running", () => {
    expect(
      getBuilderDisplayStepCount({
        isTerminal: false,
        agentLoopSteps: 25,
        eventStepCount: 18,
      }),
    ).toBe(18);
  });
});
