import { describe, expect, it, vi } from "vitest";
import {
  IntentReceiptError,
  ZERO_INTENT_SEMANTICS,
  type IntentReceipt,
  type IntentReceiptDecision,
} from "@workspace/ora-contracts";
import {
  createIntentAdmissionGovernor,
  parseIntentGrandfatheredTaskIds,
  type IntentAdmissionDependencies,
} from "./zero-intent-admission";

function receipt(overrides: Partial<IntentReceipt> = {}): IntentReceipt {
  return {
    schemaVersion: ZERO_INTENT_SEMANTICS,
    receiptId: 41,
    requestId: "request-41",
    projectId: 7,
    sourceMessageId: null,
    intent: "mutate",
    decidingSource: "user_explicit",
    confidence: null,
    reasonCode: "change_request",
    decidedAt: "2026-08-21T00:00:00.000Z",
    consumedAt: null,
    ...overrides,
  };
}

function harness(
  options: {
    enforce?: boolean;
    grandfathered?: number[];
    consumeError?: IntentReceiptError;
  } = {},
) {
  const linked = vi.fn(async () => undefined);
  const persisted = vi.fn(
    async (projectId: number, requestId: string, decision: IntentReceiptDecision) =>
      receipt({ projectId, requestId, ...decision, receiptId: 51 }),
  );
  const consume = vi.fn(async () => {
    if (options.consumeError) throw options.consumeError;
    return receipt();
  });
  const log = { info: vi.fn(), warn: vi.fn() };
  const deps: IntentAdmissionDependencies = {
    store: { persist: persisted, linkTask: linked, consumeForTask: consume },
    enforcementRequested: () => options.enforce ?? true,
    grandfatheredTaskIds: () => new Set(options.grandfathered ?? []),
    log,
  };
  return { govern: createIntentAdmissionGovernor(deps), linked, persisted, consume, log };
}

describe("zero intent mutation admission", () => {
  it("binds a matching unconsumed mutate receipt at creator time", async () => {
    const { govern, linked, persisted } = harness();
    await expect(
      govern({
        phase: "creator",
        projectId: 7,
        taskId: 9,
        requestId: "request-41",
        mutationCapable: true,
        receipt: receipt(),
      }),
    ).resolves.toEqual({ receiptId: 41, requestId: "request-41", mode: "creator" });
    expect(linked).toHaveBeenCalledWith(41, 9, 7);
    expect(persisted).not.toHaveBeenCalled();
  });

  it("mints queue, system, and scheduled mutation receipts through the same governor", async () => {
    for (const source of ["queue_promoted", "system_action", "scheduled_action"] as const) {
      const { govern, persisted } = harness();
      await govern({
        phase: "creator",
        projectId: 7,
        taskId: 9,
        requestId: `${source}:9`,
        mutationCapable: true,
        source,
      });
      expect(persisted).toHaveBeenCalledWith(
        7,
        `${source}:9`,
        expect.objectContaining({ intent: "mutate", decidingSource: source }),
      );
    }
  });

  it("rejects answer, clarify, plan, and observe receipts before mutation execution", async () => {
    for (const intent of ["answer", "clarify", "plan", "observe"] as const) {
      const { govern } = harness();
      await expect(
        govern({
          phase: "creator",
          projectId: 7,
          taskId: 9,
          requestId: "request-41",
          mutationCapable: true,
          receipt: receipt({ intent }),
        }),
      ).rejects.toMatchObject({ code: "intent_receipt_mutation_required" });
    }
  });

  it("consumes one matching receipt and lets only the same task retry idempotently", async () => {
    const { govern, consume } = harness();
    await govern({ phase: "execution", projectId: 7, taskId: 9, intentReceiptId: 41 });
    await govern({ phase: "execution", projectId: 7, taskId: 9, intentReceiptId: 41 });
    expect(consume).toHaveBeenCalledTimes(2);
    expect(consume).toHaveBeenNthCalledWith(1, { receiptId: 41, taskId: 9, projectId: 7 });
  });

  it("rejects missing, mismatched, non-mutate, and cross-task receipts when enforcement is on", async () => {
    const missing = harness({ enforce: true });
    await expect(
      missing.govern({ phase: "execution", projectId: 7, taskId: 9 }),
    ).rejects.toMatchObject({ code: "intent_receipt_not_found" });

    for (const code of [
      "intent_receipt_admission_mismatch",
      "intent_receipt_mutation_required",
      "intent_receipt_task_conflict",
    ] as const) {
      const current = harness({ enforce: true, consumeError: new IntentReceiptError(code) });
      await expect(
        current.govern({ phase: "execution", projectId: 7, taskId: 9, intentReceiptId: 41 }),
      ).rejects.toMatchObject({ code });
    }
  });

  it("logs would-have-rejected counts without blocking while audit mode is off", async () => {
    const { govern, log } = harness({ enforce: false });
    await expect(govern({ phase: "execution", projectId: 7, taskId: 9 })).resolves.toMatchObject({
      mode: "audit",
    });
    expect(log.warn).toHaveBeenCalledWith(
      { taskId: 9, projectId: 7, code: "intent_receipt_not_found", count: 1 },
      "zero-intent mutation admission would reject",
    );
  });

  it("grandfathers only an explicitly enumerated pre-cutover task", async () => {
    const accepted = harness({ enforce: true, grandfathered: [9] });
    await expect(
      accepted.govern({ phase: "execution", projectId: 7, taskId: 9 }),
    ).resolves.toMatchObject({ mode: "grandfathered" });
    const denied = harness({ enforce: true, grandfathered: [10] });
    await expect(
      denied.govern({ phase: "execution", projectId: 7, taskId: 9 }),
    ).rejects.toMatchObject({ code: "intent_receipt_not_found" });
  });

  it("fails closed on an invalid grandfather list", () => {
    expect(() => parseIntentGrandfatheredTaskIds("9,not-a-task")).toThrowError(
      expect.objectContaining({ code: "intent_receipt_grandfather_invalid" }),
    );
    expect([...parseIntentGrandfatheredTaskIds("9,10")]).toEqual([9, 10]);
  });
});
