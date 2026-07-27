import { describe, expect, it } from "vitest";
import { getBuilderCompletionMessage, STEP_CAP_COMPLETION_MESSAGE } from "./builder-completion";

describe("Builder completion messages", () => {
  it("never labels a step-cap task as a plain completed build", () => {
    expect(getBuilderCompletionMessage("step_cap")).toBe(STEP_CAP_COMPLETION_MESSAGE);
    expect(getBuilderCompletionMessage("step_cap")).not.toBe("Build complete");
  });

  it("preserves the normal finalized completion message", () => {
    expect(getBuilderCompletionMessage("finalized", "Build complete")).toBe("Build complete");
  });
});
