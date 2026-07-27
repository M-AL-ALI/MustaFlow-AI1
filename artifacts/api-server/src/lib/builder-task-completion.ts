import type { AgentTaskCompletionKind } from "@workspace/db";

export function buildAgentTaskTerminalUpdate(input: {
  completionKind: AgentTaskCompletionKind;
  finalStepCount: number;
  completedAt: Date;
}) {
  return {
    status: "completed" as const,
    completionKind: input.completionKind,
    currentStep: input.finalStepCount,
    completedAt: input.completedAt,
  };
}
