import { describe, expect, it } from "vitest";
import {
  builderCreditCost,
  mapIntentToSendOptions,
  resolveBuilderComposerIntent,
} from "./builder-followup-submit";

describe("Deep Reasoning pricing", () => {
  it("uses the fixed price table for all modes and deep variants", () => {
    expect(builderCreditCost("lite", false)).toBe(1);
    expect(builderCreditCost("eco", false)).toBe(2);
    expect(builderCreditCost("power", false)).toBe(5);
    expect(builderCreditCost("pro", false)).toBe(10);
    expect(builderCreditCost("eco", true)).toBe(3);
    expect(builderCreditCost("power", true)).toBe(7);
    expect(builderCreditCost("pro", true)).toBe(13);
    // Deep on Lite is always Lite pricing (Deep is disabled for Lite)
    expect(builderCreditCost("lite", true)).toBe(1);
  });
});

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
