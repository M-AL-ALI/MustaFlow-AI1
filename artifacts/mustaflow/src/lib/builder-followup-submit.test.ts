import { describe, expect, it } from "vitest";
import { resolveBuilderComposerIntent } from "./builder-followup-submit";

describe("resolveBuilderComposerIntent", () => {
  it("routes a Main Agent follow-up after a completed task through the build mutation", () => {
    expect(
      resolveBuilderComposerIntent({
        activeIntent: null,
        localIntent: null,
        hasCompletedTask: true,
        routingAgentIdentity: "main",
      }),
    ).toBe("build");
  });

  it("preserves explicit local intent and does not force an initial message into build", () => {
    expect(
      resolveBuilderComposerIntent({
        activeIntent: null,
        localIntent: "converse",
        hasCompletedTask: true,
        routingAgentIdentity: "main",
      }),
    ).toBe("converse");
    expect(
      resolveBuilderComposerIntent({
        activeIntent: null,
        localIntent: null,
        hasCompletedTask: false,
        routingAgentIdentity: "main",
      }),
    ).toBeUndefined();
  });
});
