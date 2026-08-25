import { describe, expect, it } from "vitest";
import {
  builderCreditCost,
  mapIntentToSendOptions,
  resolveBuilderComposerIntent,
  shouldShowBuilderUpgradeNudge,
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
        messageText: "Maybe update this",
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
        messageText: "What does this do?",
        activeIntent: null,
        localIntent: "converse",
        hasCompletedTask: true,
        routingAgentIdentity: "main",
      }),
    ).toBe("answer");
    expect(
      resolveBuilderComposerIntent({
        messageText: "Maybe the header",
        activeIntent: null,
        localIntent: null,
        hasCompletedTask: false,
        routingAgentIdentity: "main",
      }),
    ).toBeUndefined();
  });

  it("routes an explicit project-choice capture to answer despite negated build keywords", () => {
    const messageText =
      "Save this as a project decision: keep the site static. Save this as a project rejection: never add a database or authentication unless I explicitly reverse it. Do not build or change files.";
    expect(
      resolveBuilderComposerIntent({
        messageText,
        activeIntent: null,
        localIntent: "build",
        hasCompletedTask: true,
        routingAgentIdentity: "main",
      }),
    ).toBe("answer");
    expect(mapIntentToSendOptions({ intent: "answer", hasImages: false })).toEqual({
      agentIntent: "answer",
    });
  });

  it("does not downgrade a project-choice capture that also requests a real mutation", () => {
    expect(
      resolveBuilderComposerIntent({
        messageText:
          "Save this as a project decision: keep the site static. Then change the header.",
        activeIntent: null,
        localIntent: "build",
        hasCompletedTask: true,
        routingAgentIdentity: "main",
      }),
    ).toBe("mutate");
  });
});

describe("shouldShowBuilderUpgradeNudge", () => {
  it("does not advertise full-stack mode for a recorded rejection", () => {
    expect(
      shouldShowBuilderUpgradeNudge({
        messageText:
          "Save this as a project rejection: never add a database or authentication unless I explicitly reverse it. Do not build or change files.",
        intent: "answer",
      }),
    ).toBe(false);
  });

  it("still offers the upgrade for a real backend mutation", () => {
    expect(
      shouldShowBuilderUpgradeNudge({
        messageText: "Add database authentication",
        intent: "mutate",
      }),
    ).toBe(true);
  });
});
