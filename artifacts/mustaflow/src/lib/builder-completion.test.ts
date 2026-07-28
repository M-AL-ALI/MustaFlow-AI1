import { describe, expect, it } from "vitest";
import {
  getBuilderCheckpointLabel,
  getBuilderCompletionMessage,
  getBuilderTaskQueueLabel,
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
});
