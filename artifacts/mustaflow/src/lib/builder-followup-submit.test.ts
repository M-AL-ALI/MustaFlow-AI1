import { describe, expect, it } from "vitest";
import {
  builderCreditCost,
  mapIntentToSendOptions,
  resolveBuilderComposerIntent,
  shouldDeferComposerClearForCreditGate,
} from "./builder-followup-submit";

describe("Deep Reasoning pricing", () => {
  it("uses the fixed price table and gates Eco before sending", () => {
    expect(builderCreditCost("lite", false)).toBe(1);
    expect(builderCreditCost("eco", true)).toBe(3);
    expect(builderCreditCost("power", true)).toBe(7);
    expect(builderCreditCost("pro", true)).toBe(13);
    expect(
      shouldDeferComposerClearForCreditGate({
        agentMode: "eco",
        deepReasoning: true,
        isLikelyConverse: false,
        creditConfirmed: false,
      }),
    ).toBe(true);
  });
});

describe("shouldDeferComposerClearForCreditGate", () => {
  it("defers clearing only for unconfirmed Power and Pro builds", () => {
    expect(
      shouldDeferComposerClearForCreditGate({
        agentMode: "power",
        isLikelyConverse: false,
        creditConfirmed: false,
      }),
    ).toBe(true);
    expect(
      shouldDeferComposerClearForCreditGate({
        agentMode: "pro",
        isLikelyConverse: false,
        creditConfirmed: false,
      }),
    ).toBe(true);
    expect(
      shouldDeferComposerClearForCreditGate({
        agentMode: "eco",
        isLikelyConverse: false,
        creditConfirmed: false,
      }),
    ).toBe(false);
    expect(
      shouldDeferComposerClearForCreditGate({
        agentMode: "power",
        isLikelyConverse: true,
        creditConfirmed: false,
      }),
    ).toBe(false);
    expect(
      shouldDeferComposerClearForCreditGate({
        agentMode: "power",
        isLikelyConverse: false,
        creditConfirmed: true,
      }),
    ).toBe(false);
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
