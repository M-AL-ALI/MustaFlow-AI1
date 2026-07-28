import { describe, expect, it } from "vitest";
import {
  backgroundPlanStepStatus,
  isGeneratedPlanStepPrompt,
  shouldAutoMergeBackgroundPlanStep,
  shouldStageBackgroundPlanStep,
} from "./background-plan-step.js";

const generatedPrompt = "[Step 2/4: Add task form]\n\nAdd the form and validation.";

describe("background plan-step routing", () => {
  it("recognizes the stable PlanDecomposeView prompt marker", () => {
    expect(isGeneratedPlanStepPrompt(generatedPrompt)).toBe(true);
    expect(isGeneratedPlanStepPrompt("Add the form and validation.")).toBe(false);
  });

  it("stages only background, non-planning decomposed steps", () => {
    expect(
      shouldStageBackgroundPlanStep({
        prompt: generatedPrompt,
        background: true,
        planMode: false,
      }),
    ).toBe(true);
    expect(
      shouldStageBackgroundPlanStep({
        prompt: generatedPrompt,
        background: false,
        planMode: false,
      }),
    ).toBe(false);
    expect(
      shouldStageBackgroundPlanStep({
        prompt: generatedPrompt,
        background: true,
        planMode: true,
      }),
    ).toBe(false);
  });

  it("auto-merges only the staged task-identity execution", () => {
    expect(
      shouldAutoMergeBackgroundPlanStep({
        prompt: generatedPrompt,
        background: true,
        agentIdentity: "task",
      }),
    ).toBe(true);
    expect(
      shouldAutoMergeBackgroundPlanStep({
        prompt: generatedPrompt,
        background: true,
        agentIdentity: "main",
      }),
    ).toBe(false);
  });

  it("provides calm start and merge status lines", () => {
    expect(backgroundPlanStepStatus(42, "started")).toBe(
      "Background plan step started - Task #42 is working in staging.",
    );
    expect(backgroundPlanStepStatus(42, "merged")).toBe(
      "Background plan step merged - Task #42 passed staging checks and is now live.",
    );
  });
});
