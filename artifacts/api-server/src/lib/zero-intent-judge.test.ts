import { describe, expect, it, vi } from "vitest";
import { judgeZeroIntent, type ZeroIntentJudgeInput } from "./zero-intent-judge";
import type { IntentResult } from "./builder";

function input(overrides: Partial<ZeroIntentJudgeInput> = {}): ZeroIntentJudgeInput {
  return {
    planMode: false,
    approvedPlanStep: false,
    imageGenerationRequested: false,
    attachments: [],
    classify: async () => ({
      intent: "answer",
      legacyIntent: "converse",
      confidence: 0.9,
      decisionSource: "classifier",
    }),
    ...overrides,
  };
}

describe("zero intent shadow judge", () => {
  it.each([
    ["converse", "answer"],
    ["answer", "answer"],
    ["clarify", "clarify"],
    ["explain", "answer"],
    ["plan", "plan"],
    ["build", "mutate"],
    ["refactor", "mutate"],
    ["fix_tests", "mutate"],
    ["fix_types", "mutate"],
    ["fix_lint", "mutate"],
    ["debug", "observe"],
    ["observe", "observe"],
    ["review", "observe"],
  ] as const)("maps explicit %s to %s", async (explicitControl, intent) => {
    const classify = vi.fn();
    await expect(judgeZeroIntent(input({ explicitControl, classify }))).resolves.toMatchObject({
      intent,
      decidingSource: "user_explicit",
      confidence: null,
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("pins an approved plan step to mutate without reclassification", async () => {
    const classify = vi.fn();
    await expect(
      judgeZeroIntent(input({ approvedPlanStep: true, planMode: true, classify })),
    ).resolves.toEqual({
      intent: "mutate",
      decidingSource: "plan_approved",
      confidence: null,
      reasonCode: "approved_plan_step",
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("treats attachments as evidence data rather than an intent override", async () => {
    await expect(
      judgeZeroIntent(input({ attachments: [{ kind: "image", url: "opaque-ref" }] })),
    ).resolves.toMatchObject({ intent: "answer", decidingSource: "classifier" });
  });

  it("routes classifier fallback and low confidence to one clarification", async () => {
    const fallback: IntentResult = {
      intent: "mutate",
      legacyIntent: "build",
      confidence: 0.6,
      decisionSource: "classifier_fallback",
    };
    await expect(judgeZeroIntent(input({ classify: async () => fallback }))).resolves.toEqual({
      intent: "clarify",
      decidingSource: "classifier_fallback",
      confidence: null,
      reasonCode: "classifier_unavailable",
    });
    await expect(
      judgeZeroIntent(
        input({
          classify: async () => ({
            intent: "mutate",
            legacyIntent: "build",
            confidence: 0.69,
            decisionSource: "classifier",
          }),
        }),
      ),
    ).resolves.toMatchObject({
      intent: "clarify",
      decidingSource: "classifier",
      confidence: 0.69,
      reasonCode: "ambiguous_request",
    });
  });

  it.each([
    ["answer", "answer"],
    ["clarify", "clarify"],
    ["plan", "plan"],
    ["mutate", "mutate"],
    ["observe", "observe"],
  ] as const)("maps classified %s to %s deterministically", async (classified, expected) => {
    await expect(
      judgeZeroIntent(
        input({
          classify: async () => ({
            intent: classified,
            legacyIntent:
              classified === "mutate" || classified === "observe"
                ? "build"
                : classified === "plan"
                  ? "plan"
                  : "converse",
            confidence: 0.91,
            decisionSource: "classifier",
          }),
        }),
      ),
    ).resolves.toMatchObject({ intent: expected, confidence: 0.91 });
  });
});
