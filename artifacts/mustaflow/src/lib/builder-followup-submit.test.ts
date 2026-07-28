import { describe, expect, it } from "vitest";
import {
  mapIntentToSendOptions,
  resolveBuilderComposerIntent,
} from "./builder-followup-submit";

describe("mapIntentToSendOptions", () => {
  it("forwards a text-only build intent to the task-creating send path", () => {
    expect(mapIntentToSendOptions({ intent: "build", hasImages: false })).toEqual({
      agentIntent: "build",
    });
  });

  it("preserves plan mode and forces image messages through build", () => {
    expect(mapIntentToSendOptions({ intent: "plan", hasImages: false })).toEqual({
      planMode: true,
      agentIntent: "plan",
    });
    expect(mapIntentToSendOptions({ intent: "converse", hasImages: true })).toEqual({
      agentIntent: "build",
    });
  });
});

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
