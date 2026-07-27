import type { AgentTaskCompletionKind } from "@workspace/db";

export function builderCompletionMessage(
  completionKind: AgentTaskCompletionKind,
  finalizedMessage: string,
): string {
  switch (completionKind) {
    case "step_cap":
      return "Completed at the step limit — you can continue with a follow-up prompt.";
    case "wall_clock":
      return "Completed at the time limit — you can continue with a follow-up prompt.";
    case "repeated_error":
      return "Stopped after repeated errors — try a different approach or follow-up prompt.";
    case "model_stopped":
      return "Stopped before finalization — you can continue with a follow-up prompt.";
    case "aborted":
      return "Cancelled.";
    case "checks_failed":
      return "Completed with validation errors — review the report before continuing.";
    case "check_blocked":
      return "Stopped because required checks could not pass — review the report.";
    case "rate_limited":
      return "Stopped because the tool rate limit was reached — try again later.";
    case "container_unavailable":
      return "Completed with live-server validation unavailable.";
    case "finalized":
      return finalizedMessage;
  }
}

export function builderPersistedCompletionSummary(
  completionKind: AgentTaskCompletionKind,
  finalizedSummary: string,
): string {
  if (completionKind === "finalized") return finalizedSummary;

  const summary = finalizedSummary.trim().replace(/[.!?]+$/, "");
  const completionMessage = builderCompletionMessage(completionKind, finalizedSummary);
  const outcome = completionMessage
    .replace(/^Completed at the /, "reached the ")
    .replace(/^Completed with /, "completed with ")
    .replace(/^Stopped /, "stopped ")
    .replace(/^Cancelled\.$/, "cancelled.");

  return summary ? `${summary} — ${outcome}` : completionMessage;
}

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
