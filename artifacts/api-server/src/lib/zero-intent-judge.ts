import type {
  IntentReceiptDecision,
  ZeroIntent,
  ZeroIntentReasonCode,
} from "@workspace/ora-contracts";
import type { IntentResult } from "./builder";

export type ZeroIntentExplicitControl =
  | ZeroIntent
  | "converse"
  | "plan"
  | "build"
  | "debug"
  | "refactor"
  | "review"
  | "explain"
  | "fix_tests"
  | "fix_types"
  | "fix_lint";

export interface ZeroIntentJudgeInput {
  explicitControl?: ZeroIntentExplicitControl;
  mutationForbidden: boolean;
  planMode: boolean;
  approvedPlanStep: boolean;
  imageGenerationRequested: boolean;
  attachments: readonly unknown[];
  classify(): Promise<IntentResult>;
}

const EXPLICIT_NO_PROJECT_MUTATION =
  /^\s*(?:please\s+)?(?:do\s+not|don't|dont|never)\s+(?:change|modify|edit|update|build|mutate)\s+(?:this|the|my)\s+(?:project|app|codebase)\b/iu;

/**
 * A whole-project no-change instruction is a user control, not classifier advice.
 * Keep the match deliberately anchored and narrow so quoted or object-specific
 * phrases such as "do not change the heading" do not suppress a real build.
 */
export function isExplicitNoProjectMutationRequest(content: string): boolean {
  return EXPLICIT_NO_PROJECT_MUTATION.test(content);
}

function explicitDecision(control: ZeroIntentExplicitControl): IntentReceiptDecision {
  if (control === "answer" || control === "converse" || control === "explain") {
    return {
      intent: "answer",
      decidingSource: "user_explicit",
      confidence: null,
      reasonCode: "explicit_control",
    };
  }
  if (control === "clarify") {
    return {
      intent: "clarify",
      decidingSource: "user_explicit",
      confidence: null,
      reasonCode: "ambiguous_request",
    };
  }
  if (control === "plan") {
    return {
      intent: "plan",
      decidingSource: "user_explicit",
      confidence: null,
      reasonCode: "explicit_control",
    };
  }
  if (control === "observe" || control === "debug" || control === "review") {
    return {
      intent: "observe",
      decidingSource: "user_explicit",
      confidence: null,
      reasonCode: "explicit_control",
    };
  }
  return {
    intent: "mutate",
    decidingSource: "user_explicit",
    confidence: null,
    reasonCode: "explicit_control",
  };
}

function classifierReason(intent: IntentResult["intent"]): ZeroIntentReasonCode {
  if (intent === "plan") return "plan_request";
  if (intent === "observe") return "diagnostic_request";
  if (intent === "mutate") return "change_request";
  if (intent === "clarify") return "ambiguous_request";
  return "question";
}

export async function judgeZeroIntent(input: ZeroIntentJudgeInput): Promise<IntentReceiptDecision> {
  // Attachments are evidence supplied to the chosen action, never an intent override.
  void input.attachments;

  if (input.approvedPlanStep) {
    return {
      intent: "mutate",
      decidingSource: "plan_approved",
      confidence: null,
      reasonCode: "approved_plan_step",
    };
  }
  if (input.explicitControl) return explicitDecision(input.explicitControl);
  if (input.mutationForbidden) {
    return {
      intent: "answer",
      decidingSource: "user_explicit",
      confidence: null,
      reasonCode: "explicit_control",
    };
  }
  if (input.planMode) {
    return {
      intent: "plan",
      decidingSource: "user_explicit",
      confidence: null,
      reasonCode: "plan_request",
    };
  }
  if (input.imageGenerationRequested) {
    return {
      intent: "mutate",
      decidingSource: "deterministic_rule",
      confidence: 1,
      reasonCode: "media_generation_request",
    };
  }

  let classified: IntentResult;
  try {
    classified = await input.classify();
  } catch {
    return {
      intent: "clarify",
      decidingSource: "classifier_fallback",
      confidence: null,
      reasonCode: "classifier_unavailable",
    };
  }
  if (classified.decisionSource === "classifier_fallback") {
    return {
      intent: "clarify",
      decidingSource: "classifier_fallback",
      confidence: null,
      reasonCode: "classifier_unavailable",
    };
  }
  if (classified.confidence < 0.7) {
    return {
      intent: "clarify",
      decidingSource: classified.decisionSource,
      confidence: classified.confidence,
      reasonCode: "ambiguous_request",
    };
  }

  return {
    intent: classified.intent,
    decidingSource: classified.decisionSource,
    confidence: classified.confidence,
    reasonCode: classifierReason(classified.intent),
  };
}

export function intentReceiptEnforcementRequested(
  value: string | undefined = process.env.ZERO_INTENT_RECEIPT_ENFORCEMENT,
): boolean {
  return value?.trim().toLowerCase() === "true";
}
