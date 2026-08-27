import type { ZeroTerminalStopEvidence } from "@workspace/ora-contracts";

export type ZeroCapabilityId =
  | "Z-A"
  | "Z-B"
  | "Z-C"
  | "Z-D"
  | "Z-F"
  | "Z-G"
  | "Z-J"
  | "Z-K"
  | "Z-L"
  | "Z-M"
  | "Z-N"
  | "Z-O"
  | "Z-P"
  | "Z-S"
  | "Z-AA";

export type ZeroProviderFailureBehavior =
  | "local_clarification"
  | "typed_failure_terminal"
  | "failed_evaluation"
  | "durable_failed_call_receipt"
  | "not_provider_dependent";

export type ZeroProviderContractFallback = Readonly<{
  behavior: ZeroProviderFailureBehavior;
  preserves: string;
}>;

/**
 * Closed census for the 15 user-visible Zero contracts. It prevents a provider
 * outage from silently changing one capability into another capability.
 */
const ZERO_PROVIDER_CONTRACT_FALLBACKS: Readonly<
  Record<ZeroCapabilityId, ZeroProviderContractFallback>
> = {
  "Z-A": { behavior: "local_clarification", preserves: "intent is clarify" },
  "Z-B": { behavior: "local_clarification", preserves: "one focused question" },
  "Z-C": { behavior: "not_provider_dependent", preserves: "stored memory truth" },
  "Z-D": { behavior: "typed_failure_terminal", preserves: "honest progress" },
  "Z-F": { behavior: "not_provider_dependent", preserves: "recorded decision truth" },
  "Z-G": { behavior: "not_provider_dependent", preserves: "read-only reconciliation" },
  "Z-J": { behavior: "not_provider_dependent", preserves: "recorded provenance" },
  "Z-K": { behavior: "not_provider_dependent", preserves: "version binding" },
  "Z-L": { behavior: "failed_evaluation", preserves: "evaluation cannot pass" },
  "Z-M": {
    behavior: "durable_failed_call_receipt",
    preserves: "resolved call identity",
  },
  "Z-N": { behavior: "typed_failure_terminal", preserves: "observe never mutates" },
  "Z-O": { behavior: "typed_failure_terminal", preserves: "upload remains intact" },
  "Z-P": { behavior: "typed_failure_terminal", preserves: "answer never mutates" },
  "Z-S": { behavior: "not_provider_dependent", preserves: "template identity" },
  "Z-AA": { behavior: "typed_failure_terminal", preserves: "publish state truth" },
};

export function providerFailureBehaviorForCapability(
  capability: ZeroCapabilityId,
): ZeroProviderContractFallback {
  return ZERO_PROVIDER_CONTRACT_FALLBACKS[capability];
}

export type LocalClarificationFallback = Readonly<{
  question: string;
  options: readonly [string, string] | readonly [string, string, string];
  stopEvidence: ZeroTerminalStopEvidence;
}>;

const FAILURE_WORDS = /\b(broken|error|failed|failing|issue|problem|wrong|not working)\b/i;
const VISUAL_WORDS = /\b(color|content|copy|design|layout|page|screen|style|visual)\b/i;
const APP_WORDS = /\b(app|build|feature|project|site|website)\b/i;

/** Provider-free and deterministic: exactly one question, never conversation. */
export function localClarificationFallback(userPrompt: string): LocalClarificationFallback {
  const input = userPrompt.trim();
  const common = {
    stopEvidence: {
      source: "local_contract_fallback" as const,
      fallbackCode: "clarification_provider_unavailable" as const,
    },
  };

  if (FAILURE_WORDS.test(input)) {
    return {
      ...common,
      question: "Should I investigate what is wrong, or repair it now?",
      options: ["Investigate only", "Repair it now"],
    };
  }
  if (VISUAL_WORDS.test(input)) {
    return {
      ...common,
      question: "Should I change the content, the layout, or the visual style?",
      options: ["Change the content", "Change the layout", "Change the style"],
    };
  }
  if (APP_WORDS.test(input)) {
    return {
      ...common,
      question: "Should I explain the current app, plan a change, or build it now?",
      options: ["Explain the app", "Plan a change", "Build it now"],
    };
  }
  return {
    ...common,
    question: "Should I explain it, plan it, or change it now?",
    options: ["Explain it", "Plan it", "Change it now"],
  };
}
