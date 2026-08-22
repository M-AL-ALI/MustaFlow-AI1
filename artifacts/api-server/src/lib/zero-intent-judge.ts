import type { IntentReceiptDecision, ZeroIntentReasonCode } from "@workspace/ora-contracts";
import type { IntentResult } from "./builder";

export type ZeroIntentExplicitControl =
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
  planMode: boolean;
  approvedPlanStep: boolean;
  imageGenerationRequested: boolean;
  attachments: readonly unknown[];
  classify(): Promise<IntentResult>;
}

function explicitDecision(control: ZeroIntentExplicitControl): IntentReceiptDecision {
  if (control === "converse" || control === "explain") {
    return {
      intent: "answer",
      decidingSource: "user_explicit",
      confidence: null,
      reasonCode: "explicit_control",
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
  if (control === "debug" || control === "review") {
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
  if (intent === "debug" || intent === "review") return "diagnostic_request";
  if (intent === "build" || intent === "refactor") return "change_request";
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

  const classified = await input.classify();
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

  const intent =
    classified.intent === "plan"
      ? "plan"
      : classified.intent === "debug" || classified.intent === "review"
        ? "observe"
        : classified.intent === "build" || classified.intent === "refactor"
          ? "mutate"
          : "answer";
  return {
    intent,
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

export type IntentShadowOutcome<TLegacy, TReceipt> =
  | {
      legacyIntent: TLegacy;
      decision: IntentReceiptDecision;
      receipt: TReceipt;
      errorType: null;
    }
  | {
      legacyIntent: TLegacy;
      decision: null;
      receipt: null;
      errorType: string;
    };

/** Observe and persist a shadow decision while returning the legacy decision unchanged. */
export async function runIntentShadow<TLegacy, TReceipt>(
  legacyIntent: TLegacy,
  input: ZeroIntentJudgeInput,
  persist: (decision: IntentReceiptDecision) => Promise<TReceipt>,
): Promise<IntentShadowOutcome<TLegacy, TReceipt>> {
  try {
    const decision = await judgeZeroIntent(input);
    return {
      legacyIntent,
      decision,
      receipt: await persist(decision),
      errorType: null,
    };
  } catch (error) {
    return {
      legacyIntent,
      decision: null,
      receipt: null,
      errorType: error instanceof Error ? error.name : "UnknownError",
    };
  }
}
