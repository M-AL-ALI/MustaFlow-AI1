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
    case "container_unavailable":
      return "Completed with live-server validation unavailable";
    case "finalized":
    case null:
    case undefined:
    default:
      return finalizedMessage;
  }
}

export function getBuilderTaskQueueLabel(
  status: string,
  completionKind: string | null | undefined,
): string {
  if (status !== "completed") return status;

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
