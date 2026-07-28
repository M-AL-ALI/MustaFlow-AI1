type PlanStepRequest = {
  prompt: string;
  background: boolean;
  planMode?: boolean;
};

type AutoMergePlanStep = PlanStepRequest & {
  agentIdentity?: string | null;
};

const PLAN_STEP_PROMPT = /^\s*\[Step\s+\d+\/(?:\d+|\?):\s+[^\r\n]+\]\r?\n\r?\n\S/;

/**
 * PlanDecomposeView prefixes every generated step with a stable marker. Keep
 * this recognition narrow so ordinary background work continues through Main
 * Agent and only explicit decomposed steps enter the staging/merge path.
 */
export function isGeneratedPlanStepPrompt(prompt: string): boolean {
  return PLAN_STEP_PROMPT.test(prompt);
}

export function shouldStageBackgroundPlanStep(input: PlanStepRequest): boolean {
  return input.background && !input.planMode && isGeneratedPlanStepPrompt(input.prompt);
}

export function shouldAutoMergeBackgroundPlanStep(input: AutoMergePlanStep): boolean {
  return input.agentIdentity === "task" && shouldStageBackgroundPlanStep(input);
}

export type BackgroundPlanStepPhase = "queued" | "started" | "merging" | "merged";

export function backgroundPlanStepStatus(taskId: number, phase: BackgroundPlanStepPhase): string {
  switch (phase) {
    case "queued":
      return `Background plan step queued - Task #${taskId} will build in staging and merge automatically after checks pass.`;
    case "started":
      return `Background plan step started - Task #${taskId} is working in staging.`;
    case "merging":
      return `Background plan step passed staging checks - merging Task #${taskId} into the project.`;
    case "merged":
      return `Background plan step merged - Task #${taskId} passed staging checks and is now live.`;
  }
}
