import { describe, expect, it, vi } from "vitest";
import {
  isExplicitNoProjectMutationRequest,
  judgeZeroIntent,
  type ZeroIntentJudgeInput,
} from "./zero-intent-judge";
import type { IntentResult } from "./builder";

function input(overrides: Partial<ZeroIntentJudgeInput> = {}): ZeroIntentJudgeInput {
  return {
    planMode: false,
    approvedPlanStep: false,
    mutationForbidden: false,
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

  it("keeps an attached reference question out of the build path when the user forbids changes", async () => {
    const classify = vi.fn(async () => ({
      intent: "mutate" as const,
      legacyIntent: "build" as const,
      confidence: 0.99,
      decisionSource: "classifier" as const,
    }));
    const content =
      "Do not change this project. Read both attached items as reference data and answer briefly.";

    expect(isExplicitNoProjectMutationRequest(content)).toBe(true);
    await expect(
      judgeZeroIntent(
        input({
          mutationForbidden: isExplicitNoProjectMutationRequest(content),
          attachments: [{ kind: "image" }, { kind: "file" }],
          classify,
        }),
      ),
    ).resolves.toEqual({
      intent: "answer",
      decidingSource: "user_explicit",
      confidence: null,
      reasonCode: "explicit_control",
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("does not mistake an object-specific editing constraint for a whole-project no-change control", () => {
    expect(
      isExplicitNoProjectMutationRequest("Do not change the heading; update the footer."),
    ).toBe(false);
  });

  it.each([
    "Comparison audit only. Validate this existing app without modifying any project files. Read the current package scripts, then run the existing typecheck and production-build checks only if their tools are already installed.",
    "First inspect the source. Do not modify any project files. Run the existing checks.",
    "Audit only; please don't edit the codebase. Check types.",
    "Please don\u2019t touch my app. Explain its architecture.",
    "Review this project without changing any files.",
    "Leave all project files unchanged. Run typecheck.",
    "Keep the existing project files unchanged; inspect the scripts.",
    "Do not change this project at all.",
  ])("honors an explicit no-change boundary: %s", async (content) => {
    const classify = vi.fn();
    expect(isExplicitNoProjectMutationRequest(content)).toBe(true);
    await expect(
      judgeZeroIntent(
        input({
          mutationForbidden: isExplicitNoProjectMutationRequest(content),
          explicitControl: "build",
          approvedPlanStep: true,
          planMode: true,
          imageGenerationRequested: true,
          classify,
        }),
      ),
    ).resolves.toMatchObject({ intent: "answer", decidingSource: "user_explicit" });
    expect(classify).not.toHaveBeenCalled();
  });

  it.each([
    "Do not change the project name; update the footer.",
    "Do not change the app icon. Add a settings page.",
    "Do not change the heading; update the footer.",
    "Add a new route without modifying existing files.",
    'Explain the phrase "Do not change this project."',
    "Explain this example: `Do not change this project.`",
    "Explain this example:\n```text\nDo not change this project.\n```",
    "Explain this example:\n~~~text\nDo not change this project.\n~~~",
    "Build the app and run the tests.",
  ])(
    "does not turn a narrower constraint or quotation into global read-only intent: %s",
    (content) => {
      expect(isExplicitNoProjectMutationRequest(content)).toBe(false);
    },
  );

  it.each([
    "Do not modify this project in any way. Run typecheck.",
    "Do not modify this project in any way whatsoever. Run typecheck.",
    "Don't change my app whatsoever; run npm test.",
    "Do not alter the codebase under any circumstances. Run npm test.",
    "Validate the current app without modifying any project files in any way.",
    "Keep the project unchanged for now. Run the existing checks.",
  ])(
    "preserves qualified whole-project prohibitions over Build and approved steps: %s",
    async (content) => {
      const classify = vi.fn();
      expect(isExplicitNoProjectMutationRequest(content)).toBe(true);
      await expect(
        judgeZeroIntent(
          input({
            mutationForbidden: isExplicitNoProjectMutationRequest(content),
            explicitControl: "build",
            approvedPlanStep: true,
            classify,
          }),
        ),
      ).resolves.toMatchObject({ intent: "answer", decidingSource: "user_explicit" });
      expect(classify).not.toHaveBeenCalled();
    },
  );

  it.each([
    "Do not change the project name in any way; update the footer.",
    "Do not change the app icon at all. Add a settings page.",
    'Explain "Do not modify this project in any way."',
  ])(
    "does not expand a qualified narrow constraint or quoted example to the entire app: %s",
    (content) => {
      expect(isExplicitNoProjectMutationRequest(content)).toBe(false);
    },
  );

  it.each([
    "until I approve changes",
    "yet",
    "during this audit",
    "while we discuss the design",
    "before the release review",
    "unless I explicitly request it",
    "for the remainder of this session",
    "because this is a read-only check",
    "under the current review policy",
    "today",
    "without another decision",
    "in ways that affect production",
  ])("keeps the project veto with an unrestricted qualifier: %s", async (qualifier) => {
    for (const instruction of [
      "Do not modify this project",
      "Inspect scripts without modifying this project",
      "Keep this project unchanged",
    ]) {
      const prompt = instruction + " " + qualifier + ". Run typecheck.";
      const classify = vi.fn();
      expect(isExplicitNoProjectMutationRequest(prompt)).toBe(true);
      await expect(
        judgeZeroIntent(
          input({
            mutationForbidden: isExplicitNoProjectMutationRequest(prompt),
            explicitControl: "build",
            approvedPlanStep: true,
            classify,
          }),
        ),
      ).resolves.toMatchObject({ intent: "answer", decidingSource: "user_explicit" });
      expect(classify).not.toHaveBeenCalled();
    }
  });

  it.each([
    "Do not change this project's name. Add a footer.",
    "Do not modify the app's icon. Add a settings page.",
    "Do not change this project title during the audit. Update the footer.",
    "Do not touch the app logo until I approve it. Add a page.",
  ])("does not turn a property constraint into a project veto: %s", (prompt) => {
    expect(isExplicitNoProjectMutationRequest(prompt)).toBe(false);
  });

  it.each([
    "Do not change this project's files until I approve changes.",
    "Do not modify the project's existing files during this audit.",
  ])("preserves a possessive whole-project file constraint: %s", (prompt) => {
    expect(isExplicitNoProjectMutationRequest(prompt)).toBe(true);
  });

  it.each([
    '"First inspect scripts.\nDo not change this project.\n"',
    "`First inspect scripts.\nDo not change this project.\n`",
    "\u201cFirst inspect scripts.\nDo not change this project.\n\u201d",
    "```text\nFirst inspect scripts.\nDo not change this project.\n```",
    "~~~text\nFirst inspect scripts.\nDo not change this project.\n~~~",
  ])("does not promote multiline reference material to an instruction: %s", async (reference) => {
    const prompt = "Add a help panel containing this example:\n" + reference;
    expect(isExplicitNoProjectMutationRequest(prompt)).toBe(false);
    await expect(
      judgeZeroIntent(
        input({
          mutationForbidden: isExplicitNoProjectMutationRequest(prompt),
          explicitControl: "build",
        }),
      ),
    ).resolves.toMatchObject({ intent: "mutate" });
    expect(isExplicitNoProjectMutationRequest(reference + "\nDo not change this project.")).toBe(
      true,
    );
  });

  it.each(["\n", "\r\n", "\r", "\u2028", "\u2029"])(
    "does not absorb a following Name instruction across line ending %j",
    async (lineEnding) => {
      const prompt = "Do not change this project" + lineEnding + "Name the risks you find.";
      const classify = vi.fn();
      expect(isExplicitNoProjectMutationRequest(prompt)).toBe(true);
      await expect(
        judgeZeroIntent(
          input({
            mutationForbidden: isExplicitNoProjectMutationRequest(prompt),
            explicitControl: "build",
            approvedPlanStep: true,
            classify,
          }),
        ),
      ).resolves.toMatchObject({ intent: "answer", decidingSource: "user_explicit" });
      expect(classify).not.toHaveBeenCalled();
    },
  );

  it.each([" ", "\t", "\u00a0"])(
    "still recognizes a same-line narrow property separated by %j",
    (space) => {
      expect(
        isExplicitNoProjectMutationRequest(
          "Do not change this project" + space + "name. Add a footer.",
        ),
      ).toBe(false);
    },
  );

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
