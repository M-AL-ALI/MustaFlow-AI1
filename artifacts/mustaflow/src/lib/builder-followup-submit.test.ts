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
  it("lets an explicit whole-project no-change instruction override inferred and persisted build controls", () => {
    const messageText =
      "Do not change this project. Read both attached items as reference data and answer briefly.";
    expect(
      resolveBuilderComposerIntent({
        messageText,
        activeIntent: "mutate",
        localIntent: "build",
        hasCompletedTask: true,
        routingAgentIdentity: "main",
      }),
    ).toBe("answer");
    expect(mapIntentToSendOptions({ intent: "answer", hasImages: true })).toEqual({
      agentIntent: "answer",
    });
  });

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

  it("does not treat a local hint as an explicitly selected control", () => {
    expect(
      resolveBuilderComposerIntent({
        messageText: "What does this do?",
        activeIntent: null,
        localIntent: "converse",
        hasCompletedTask: true,
        routingAgentIdentity: "main",
      }),
    ).toBeUndefined();
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

  it("leaves a mixed project-choice and mutation request to semantic classification", () => {
    expect(
      resolveBuilderComposerIntent({
        messageText:
          "Save this as a project decision: keep the site static. Then change the header.",
        activeIntent: null,
        localIntent: "build",
        hasCompletedTask: true,
        routingAgentIdentity: "main",
      }),
    ).toBeUndefined();
  });

  it.each([
    "Build this focused improvement in TeamNotebook while preserving the visual design.",
    "Create a migration plan for the database.",
    "Write a phased implementation plan for the dashboard.",
    "Write a design document for the app.",
    "Add missing steps to the project plan.",
    "Implement the approved plan.",
  ])("does not manufacture an explicit action for: %s", (messageText) => {
    for (const localIntent of ["converse", "plan", "build"] as const) {
      const intent = resolveBuilderComposerIntent({
        messageText,
        activeIntent: null,
        localIntent,
        hasCompletedTask: true,
        routingAgentIdentity: "main",
      });
      expect(intent).toBeUndefined();
      expect(mapIntentToSendOptions({ intent, hasImages: false })).toEqual({});
    }
  });

  it.each([
    ["build", "mutate"],
    ["plan", "plan"],
    ["review", "observe"],
    ["explain", "answer"],
  ] as const)("preserves the deliberately selected %s control", (activeIntent, expected) => {
    expect(
      resolveBuilderComposerIntent({
        messageText: "Use the attached reference for this app.",
        activeIntent,
        localIntent: "plan",
        hasCompletedTask: true,
        routingAgentIdentity: "main",
      }),
    ).toBe(expected);
  });
});

describe("shouldShowBuilderUpgradeNudge", () => {
  it("waits for an authoritative action instead of guessing from backend words", () => {
    expect(
      shouldShowBuilderUpgradeNudge({
        messageText: "Add database authentication",
        intent: undefined,
      }),
    ).toBe(false);
  });

  it("respects an explicit no-change instruction even with a mutation hint", () => {
    expect(
      shouldShowBuilderUpgradeNudge({
        messageText: "Do not change this project. Explain database authentication.",
        intent: "mutate",
      }),
    ).toBe(false);
  });

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
