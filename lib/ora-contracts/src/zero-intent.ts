export const ZERO_INTENT_SEMANTICS = "zero-intent-v1" as const;

export const ZERO_INTENTS = ["answer", "clarify", "plan", "mutate", "observe"] as const;
export type ZeroIntent = (typeof ZERO_INTENTS)[number];

export const ZERO_INTENT_DECIDING_SOURCES = [
  "user_explicit",
  "plan_approved",
  "deterministic_rule",
  "classifier",
  "classifier_fallback",
  "snapshot_control",
  "queue_promoted",
  "system_action",
  "scheduled_action",
] as const;
export type ZeroIntentDecidingSource = (typeof ZERO_INTENT_DECIDING_SOURCES)[number];

export const ZERO_INTENT_REASON_CODES = [
  "question",
  "ambiguous_request",
  "plan_request",
  "change_request",
  "diagnostic_request",
  "snapshot_request",
  "media_generation_request",
  "approved_plan_step",
  "explicit_control",
  "classifier_unavailable",
  "system_maintenance",
  "scheduled_run",
] as const;
export type ZeroIntentReasonCode = (typeof ZERO_INTENT_REASON_CODES)[number];

export interface IntentReceipt {
  schemaVersion: typeof ZERO_INTENT_SEMANTICS;
  receiptId: number;
  requestId: string;
  projectId: number;
  sourceMessageId: number | null;
  intent: ZeroIntent;
  decidingSource: ZeroIntentDecidingSource;
  confidence: number | null;
  reasonCode: ZeroIntentReasonCode;
  decidedAt: string;
  consumedAt: string | null;
}

export type IntentReceiptDecision = Pick<
  IntentReceipt,
  "intent" | "decidingSource" | "confidence" | "reasonCode"
>;

export const ZERO_INTENT_RECEIPT_ERROR_CODES = [
  "intent_receipt_illegal_pair",
  "intent_receipt_confidence_invalid",
  "intent_receipt_conflict",
  "intent_receipt_not_found",
  "intent_receipt_already_consumed",
  "intent_receipt_persistence_failed",
  "intent_receipt_admission_mismatch",
  "intent_receipt_mutation_required",
  "intent_receipt_task_conflict",
  "intent_receipt_grandfather_invalid",
] as const;
export type IntentReceiptErrorCode = (typeof ZERO_INTENT_RECEIPT_ERROR_CODES)[number];

export class IntentReceiptError extends Error {
  readonly name = "IntentReceiptError";

  constructor(readonly code: IntentReceiptErrorCode) {
    super(code);
  }
}

const ALLOWED_INTENTS_BY_SOURCE: Readonly<Record<ZeroIntentDecidingSource, readonly ZeroIntent[]>> =
  {
    user_explicit: ZERO_INTENTS,
    plan_approved: ["mutate"],
    deterministic_rule: ZERO_INTENTS,
    classifier: ZERO_INTENTS,
    classifier_fallback: ["clarify"],
    snapshot_control: ["observe"],
    queue_promoted: ["mutate"],
    system_action: ["mutate"],
    scheduled_action: ["mutate"],
  };

export function assertIntentReceiptDecision(
  decision: IntentReceiptDecision,
): asserts decision is IntentReceiptDecision {
  if (
    !ZERO_INTENTS.includes(decision.intent) ||
    !ZERO_INTENT_DECIDING_SOURCES.includes(decision.decidingSource) ||
    !ZERO_INTENT_REASON_CODES.includes(decision.reasonCode) ||
    !ALLOWED_INTENTS_BY_SOURCE[decision.decidingSource].includes(decision.intent)
  ) {
    throw new IntentReceiptError("intent_receipt_illegal_pair");
  }
  const ownsConfidence =
    decision.decidingSource === "classifier" || decision.decidingSource === "deterministic_rule";
  if (
    (ownsConfidence &&
      (decision.confidence === null ||
        !Number.isFinite(decision.confidence) ||
        decision.confidence < 0 ||
        decision.confidence > 1)) ||
    (!ownsConfidence && decision.confidence !== null)
  ) {
    throw new IntentReceiptError("intent_receipt_confidence_invalid");
  }
}
