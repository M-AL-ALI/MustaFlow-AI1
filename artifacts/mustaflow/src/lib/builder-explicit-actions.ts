import {
  isExplicitNoProjectMutationRequest,
  isZeroProjectChoiceCaptureOnlyMessage,
} from "@workspace/ora-contracts";
import type { BuilderReceiptIntent } from "./builder-followup-submit";

export type BuilderExplicitActionOptions = {
  planMode: false;
  agentIdentity: "main";
  agentIntent?: BuilderReceiptIntent;
};

/** A clicked Build control is approval to execute, not another classification request. */
export function builderPlanExecutionOptions(): BuilderExplicitActionOptions {
  return { planMode: false, agentIdentity: "main", agentIntent: "mutate" };
}

/** Preserve the request being clarified instead of sending a context-free reply. */
export function builderClarificationReply(option: string, originalRequest?: string) {
  const request = originalRequest?.trim();
  const content = request ? `${request}\n\nMy answer to your clarification: ${option}` : option;
  let agentIntent: BuilderReceiptIntent | undefined;
  if (
    request &&
    (isExplicitNoProjectMutationRequest(request) || isZeroProjectChoiceCaptureOnlyMessage(request))
  ) {
    agentIntent = "answer";
  } else if (option === "Repair it now") {
    agentIntent = "mutate";
  } else if (option === "Investigate only") {
    agentIntent = "observe";
  }
  const options: BuilderExplicitActionOptions = {
    planMode: false,
    agentIdentity: "main",
    ...(agentIntent ? { agentIntent } : {}),
  };
  return { content, options };
}
