import {
  IntentReceiptError,
  type IntentReceipt,
  type IntentReceiptDecision,
  type ZeroIntentDecidingSource,
} from "@workspace/ora-contracts";
import { intentReceiptStore, type IntentReceiptStore } from "./zero-intent-receipt-store";
import { intentReceiptEnforcementRequested } from "./zero-intent-judge";
import { logger } from "./logger";

export type MutationReceiptSource = Extract<
  ZeroIntentDecidingSource,
  "queue_promoted" | "system_action" | "scheduled_action"
>;

export interface IntentAdmissionLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface IntentAdmissionDependencies {
  store: Pick<IntentReceiptStore, "persist" | "linkTask" | "consumeForTask">;
  enforcementRequested(): boolean;
  grandfatheredTaskIds(): ReadonlySet<number>;
  log: IntentAdmissionLogger;
}

export type IntentAdmissionInput =
  | {
      phase: "creator";
      projectId: number;
      taskId: number;
      requestId: string;
      mutationCapable: boolean;
      receipt?: IntentReceipt;
      source?: MutationReceiptSource;
    }
  | {
      phase: "execution";
      projectId: number;
      taskId: number;
      intentReceiptId?: number | null;
    };

export interface IntentAdmissionResult {
  receiptId: number | null;
  requestId: string | null;
  mode: "enforced" | "audit" | "grandfathered" | "creator";
}

function machineDecision(source: MutationReceiptSource): IntentReceiptDecision {
  if (source === "queue_promoted") {
    return {
      intent: "mutate",
      decidingSource: source,
      confidence: null,
      reasonCode: "approved_plan_step",
    };
  }
  if (source === "scheduled_action") {
    return {
      intent: "mutate",
      decidingSource: source,
      confidence: null,
      reasonCode: "scheduled_run",
    };
  }
  return {
    intent: "mutate",
    decidingSource: source,
    confidence: null,
    reasonCode: "system_maintenance",
  };
}

export function parseIntentGrandfatheredTaskIds(
  value: string | undefined = process.env.ZERO_INTENT_RECEIPT_GRANDFATHERED_TASK_IDS,
): ReadonlySet<number> {
  if (!value?.trim()) return new Set<number>();
  const values = value.split(",").map((part) => part.trim());
  if (
    values.some(
      (part) =>
        part.length === 0 ||
        !/^\d+$/u.test(part) ||
        !Number.isSafeInteger(Number(part)) ||
        Number(part) < 1,
    )
  ) {
    throw new IntentReceiptError("intent_receipt_grandfather_invalid");
  }
  return new Set(values.map(Number));
}

export function createIntentAdmissionGovernor(deps: IntentAdmissionDependencies) {
  return async function governIntentAdmission(
    input: IntentAdmissionInput,
  ): Promise<IntentAdmissionResult> {
    if (input.phase === "creator") {
      const receipt =
        input.receipt ??
        (input.source
          ? await deps.store.persist(
              input.projectId,
              input.requestId,
              machineDecision(input.source),
            )
          : null);
      if (!receipt) throw new IntentReceiptError("intent_receipt_not_found");
      if (receipt.projectId !== input.projectId || receipt.requestId !== input.requestId) {
        throw new IntentReceiptError("intent_receipt_admission_mismatch");
      }
      if (input.mutationCapable && receipt.intent !== "mutate") {
        throw new IntentReceiptError("intent_receipt_mutation_required");
      }
      if (receipt.consumedAt !== null) {
        throw new IntentReceiptError("intent_receipt_already_consumed");
      }
      await deps.store.linkTask(receipt.receiptId, input.taskId, input.projectId);
      return {
        receiptId: receipt.receiptId,
        requestId: receipt.requestId,
        mode: "creator",
      };
    }

    const enforce = deps.enforcementRequested();
    const reject = (code: string): IntentAdmissionResult => {
      if (!enforce) {
        deps.log.warn(
          { taskId: input.taskId, projectId: input.projectId, code, count: 1 },
          "zero-intent mutation admission would reject",
        );
        return { receiptId: input.intentReceiptId ?? null, requestId: null, mode: "audit" };
      }
      const grandfathered = deps.grandfatheredTaskIds();
      if (grandfathered.has(input.taskId)) {
        deps.log.warn(
          { taskId: input.taskId, projectId: input.projectId, code, count: 1 },
          "zero-intent mutation admission explicitly grandfathered",
        );
        return { receiptId: input.intentReceiptId ?? null, requestId: null, mode: "grandfathered" };
      }
      throw new IntentReceiptError(
        code === "intent_receipt_mutation_required"
          ? "intent_receipt_mutation_required"
          : code === "intent_receipt_admission_mismatch"
            ? "intent_receipt_admission_mismatch"
            : code === "intent_receipt_task_conflict"
              ? "intent_receipt_task_conflict"
              : "intent_receipt_not_found",
      );
    };

    if (!Number.isSafeInteger(input.intentReceiptId) || Number(input.intentReceiptId) < 1) {
      return reject("intent_receipt_not_found");
    }
    try {
      const receipt = await deps.store.consumeForTask({
        receiptId: Number(input.intentReceiptId),
        taskId: input.taskId,
        projectId: input.projectId,
      });
      deps.log.info(
        {
          taskId: input.taskId,
          projectId: input.projectId,
          receiptId: receipt.receiptId,
          mode: enforce ? "enforced" : "audit",
        },
        "zero-intent mutation admission accepted",
      );
      return {
        receiptId: receipt.receiptId,
        requestId: receipt.requestId,
        mode: enforce ? "enforced" : "audit",
      };
    } catch (error) {
      if (error instanceof IntentReceiptError) return reject(error.code);
      throw error;
    }
  };
}

export const governIntentAdmission = createIntentAdmissionGovernor({
  store: intentReceiptStore,
  enforcementRequested: intentReceiptEnforcementRequested,
  grandfatheredTaskIds: parseIntentGrandfatheredTaskIds,
  log: logger,
});
