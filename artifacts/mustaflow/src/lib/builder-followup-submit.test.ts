import { describe, expect, it } from "vitest";
import {
  builderCreditCost,
  mapIntentToSendOptions,
  resolveBuilderComposerIntent,
} from "./builder-followup-submit";

describe("Deep Reasoning pricing", () => {
  it("uses the fixed price table for all modes and deep variants", () => {
    expect(builderCreditCost("lite", false)).toBe(13);
    expect(builderCreditCost("eco", false)).toBe(34);
    expect(builderCreditCost("power", false)).toBe(160);
    expect(builderCreditCost("pro", false)).toBe(475);
    expect(builderCreditCost("eco", true)).toBe(60);
    expect(builderCreditCost("power", true)).toBe(290);
    expect(builderCreditCost("pro", true)).toBe(850);
    // Deep on Lite is always Lite pricing (Deep is disabled for Lite)
    expect(builderCreditCost("lite", true)).toBe(13);
  });
});

describe("mapIntentToSendOptions", () => {
  it("maps legacy mutation controls to the closed receipt intent", () => {
    expect(mapIntentToSendOptions({ intent: "build", hasImages: false })).toEqual({
      agentIntent: "mutate",
    });
    expect(mapIntentToSendOptions({ intent: "debug", hasImages: false })).toEqual({
      agentIntent: "observe",
    });
    expect(mapIntentToSendOptions({ intent: "explain", hasImages: false })).toEqual({
      agentIntent: "answer",
    });
  });

  it("preserves plan mode without allowing an image to override intent", () => {
    expect(mapIntentToSendOptions({ intent: "plan", hasImages: false })).toEqual({
      planMode: true,
      agentIntent: "plan",
    });
    expect(mapIntentToSendOptions({ intent: "converse", hasImages: true })).toEqual({
      agentIntent: "answer",
    });
  });
});

describe("resolveBuilderComposerIntent", () => {
  it("does not let a completed task override a new undecided request", () => {
    expect(
      resolveBuilderComposerIntent({
        activeIntent: null,
        localIntent: null,
        hasCompletedTask: true,
        routingAgentIdentity: "main",
      }),
    ).toBeUndefined();
  });

  it("preserves explicit local intent and does not force an initial message into build", () => {
    expect(
      resolveBuilderComposerIntent({
        activeIntent: null,
        localIntent: "converse",
        hasCompletedTask: true,
        routingAgentIdentity: "main",
      }),
    ).toBe("answer");
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
