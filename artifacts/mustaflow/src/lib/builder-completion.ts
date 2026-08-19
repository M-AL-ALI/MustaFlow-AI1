export type BuilderCompletionKind =
  | "finalized"
  | "step_cap"
  | "wall_clock"
  | "repeated_error"
  | "model_stopped"
  | "aborted"
  | "checks_failed"
  | "check_blocked"
  | "rate_limited"
  | "admission_blocked"
  | "admission_unavailable"
  | "container_unavailable";

export const STEP_CAP_COMPLETION_MESSAGE =
  "Completed at the step limit — you can continue with a follow-up prompt";

export function getBuilderCompletionMessage(
  completionKind: string | null | undefined,
  finalizedMessage = "Build complete",
): string {
  switch (completionKind as BuilderCompletionKind | null | undefined) {
    case "step_cap":
      return STEP_CAP_COMPLETION_MESSAGE;
    case "wall_clock":
      return "Completed at the time limit — you can continue with a follow-up prompt";
    case "repeated_error":
      return "Stopped after repeated errors — try a different approach or follow-up prompt";
    case "model_stopped":
      return "Stopped before finalization — you can continue with a follow-up prompt";
    case "aborted":
      return "Cancelled";
    case "checks_failed":
      return "Completed with validation errors — review the report before continuing";
    case "check_blocked":
      return "Stopped because required checks could not pass — review the report";
    case "rate_limited":
      return "Stopped because the tool rate limit was reached — try again later";
    case "admission_blocked":
      return "This build did not start because the account is already at its running-build limit";
    case "admission_unavailable":
      return "This build did not start because capacity checks are temporarily unavailable — try again shortly";
    case "container_unavailable":
      return "Completed with live-server validation unavailable";
    case "finalized":
    case null:
    case undefined:
    default:
      return finalizedMessage;
  }
}

export function getBuilderCheckpointLabel(
  label: string,
  completionKind: string | null | undefined,
): string {
  if (!completionKind || completionKind === "finalized") return label;

  const honestCompletion = getBuilderCompletionMessage(completionKind);
  const withoutLegacyCompletion = label
    .replace(/\s*Built \d+ files via agentic loop\.?/gi, "")
    .trim();

  if (withoutLegacyCompletion.includes(honestCompletion)) {
    return withoutLegacyCompletion;
  }
  return withoutLegacyCompletion
    ? `${withoutLegacyCompletion}\n${honestCompletion}`
    : honestCompletion;
}

export function getBuilderTaskQueueLabel(
  status: string,
  completionKind: string | null | undefined,
): string {
  if (
    status !== "completed" &&
    completionKind !== "admission_blocked" &&
    completionKind !== "admission_unavailable"
  ) {
    return status;
  }

  switch (completionKind as BuilderCompletionKind | null | undefined) {
    case "step_cap":
      return "Completed at limit";
    case "wall_clock":
      return "Completed at time limit";
    case "repeated_error":
    case "model_stopped":
      return "Stopped";
    case "aborted":
      return "Cancelled";
    case "checks_failed":
      return "Completed with errors";
    case "check_blocked":
      return "Blocked";
    case "rate_limited":
      return "Rate limited";
    case "admission_blocked":
      return "Not started — capacity reached";
    case "admission_unavailable":
      return "Not started — try again";
    case "container_unavailable":
      return "Completed partially";
    case "finalized":
      return "Completed";
    case null:
    case undefined:
    default:
      return status;
  }
}

export function getBuilderDisplayStepCount(input: {
  isTerminal: boolean;
  agentLoopSteps?: number | null;
  currentStep?: number | null;
  eventStepCount: number;
}): number | undefined {
  if (!input.isTerminal) return input.eventStepCount;
  return input.agentLoopSteps ?? input.currentStep ?? undefined;
}
