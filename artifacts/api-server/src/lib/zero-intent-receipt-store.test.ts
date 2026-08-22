import { describe, expect, it, vi } from "vitest";
import {
  IntentReceiptError,
  ZERO_INTENT_SEMANTICS,
  assertIntentReceiptDecision,
  type IntentReceipt,
  type IntentReceiptDecision,
} from "@workspace/ora-contracts";
import {
  IntentReceiptStore,
  type IntentReceiptPersistenceDriver,
} from "./zero-intent-receipt-store";

class MemoryIntentDriver implements IntentReceiptPersistenceDriver {
  private nextId = 1;
  readonly byKey = new Map<string, IntentReceipt>();
  readonly messages = new Map<number, number>();
  readonly tasks = new Map<number, number>();
  readonly taskProjects = new Map<number, number>();

  async find(projectId: number, requestId: string) {
    return this.byKey.get(`${projectId}:${requestId}`) ?? null;
  }

  async persist(projectId: number, requestId: string, decision: IntentReceiptDecision) {
    const key = `${projectId}:${requestId}`;
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const receipt: IntentReceipt = {
      schemaVersion: ZERO_INTENT_SEMANTICS,
      receiptId: this.nextId++,
      requestId,
      projectId,
      sourceMessageId: null,
      ...decision,
      decidedAt: "2026-08-21T00:00:00.000Z",
      consumedAt: null,
    };
    this.byKey.set(key, receipt);
    return receipt;
  }

  async linkMessage(receiptId: number, messageId: number) {
    const receipt = [...this.byKey.values()].find((candidate) => candidate.receiptId === receiptId);
    if (!receipt) throw new IntentReceiptError("intent_receipt_not_found");
    receipt.sourceMessageId = messageId;
    this.messages.set(messageId, receiptId);
  }

  async linkTask(receiptId: number, taskId: number, projectId: number) {
    const receipt = [...this.byKey.values()].find((candidate) => candidate.receiptId === receiptId);
    if (!receipt) throw new IntentReceiptError("intent_receipt_not_found");
    if (receipt.projectId !== projectId) {
      throw new IntentReceiptError("intent_receipt_admission_mismatch");
    }
    if (receipt.consumedAt !== null) {
      throw new IntentReceiptError("intent_receipt_already_consumed");
    }
    const existing = this.tasks.get(taskId);
    if (existing !== undefined && existing !== receiptId) {
      throw new IntentReceiptError("intent_receipt_task_conflict");
    }
    if (
      [...this.tasks.entries()].some(
        ([linkedTaskId, linkedReceipt]) => linkedTaskId !== taskId && linkedReceipt === receiptId,
      )
    ) {
      throw new IntentReceiptError("intent_receipt_task_conflict");
    }
    this.tasks.set(taskId, receiptId);
    this.taskProjects.set(taskId, projectId);
  }

  async consumeForTask(input: { receiptId: number; taskId: number; projectId: number }) {
    const receipt = [...this.byKey.values()].find(
      (candidate) => candidate.receiptId === input.receiptId,
    );
    if (!receipt) throw new IntentReceiptError("intent_receipt_not_found");
    if (receipt.projectId !== input.projectId) {
      throw new IntentReceiptError("intent_receipt_admission_mismatch");
    }
    if (receipt.intent !== "mutate") {
      throw new IntentReceiptError("intent_receipt_mutation_required");
    }
    if (
      this.tasks.get(input.taskId) !== input.receiptId ||
      this.taskProjects.get(input.taskId) !== input.projectId ||
      [...this.tasks.entries()].some(
        ([taskId, linkedReceipt]) => taskId !== input.taskId && linkedReceipt === input.receiptId,
      )
    ) {
      throw new IntentReceiptError("intent_receipt_task_conflict");
    }
    if (receipt.consumedAt) return receipt;
    receipt.consumedAt = "2026-08-21T00:00:01.000Z";
    return receipt;
  }
}

const answer: IntentReceiptDecision = {
  intent: "answer",
  decidingSource: "classifier",
  confidence: 0.91,
  reasonCode: "question",
};

describe("zero intent receipt persistence contract", () => {
  it("rejects illegal source-intent pairs and confidence ownership before persistence", async () => {
    const persist = vi.fn();
    const store = new IntentReceiptStore({
      find: vi.fn(),
      persist,
      linkMessage: vi.fn(),
      linkTask: vi.fn(),
      consumeForTask: vi.fn(),
    });
    await expect(
      store.persist(17, "request-a", {
        intent: "mutate",
        decidingSource: "classifier_fallback",
        confidence: null,
        reasonCode: "classifier_unavailable",
      }),
    ).rejects.toMatchObject({ code: "intent_receipt_illegal_pair" });
    expect(() =>
      assertIntentReceiptDecision({
        intent: "answer",
        decidingSource: "user_explicit",
        confidence: 0.8,
        reasonCode: "question",
      }),
    ).toThrowError(expect.objectContaining({ code: "intent_receipt_confidence_invalid" }));
    expect(persist).not.toHaveBeenCalled();
  });

  it("deduplicates by project and request while rejecting a conflicting replay", async () => {
    const driver = new MemoryIntentDriver();
    const store = new IntentReceiptStore(driver);
    const first = await store.persist(17, "request-a", answer);
    const replay = await store.persist(17, "request-a", answer);
    expect(replay).toBe(first);
    expect(driver.byKey).toHaveLength(1);
    await expect(
      store.persist(17, "request-a", { ...answer, intent: "mutate", reasonCode: "change_request" }),
    ).rejects.toMatchObject({ code: "intent_receipt_conflict" });
    await expect(store.persist(18, "request-a", answer)).resolves.toMatchObject({ projectId: 18 });
  });

  it("finds the authoritative receipt before a second route dispatch", async () => {
    const driver = new MemoryIntentDriver();
    const store = new IntentReceiptStore(driver);
    const receipt = await store.persist(17, "request-a", answer);
    await expect(store.find(17, "request-a")).resolves.toBe(receipt);
    await expect(store.find(18, "request-a")).resolves.toBeNull();
  });

  it("links one source message and consumes a receipt for at most one task", async () => {
    const driver = new MemoryIntentDriver();
    const store = new IntentReceiptStore(driver);
    const receipt = await store.persist(17, "request-a", {
      intent: "mutate",
      decidingSource: "user_explicit",
      confidence: null,
      reasonCode: "change_request",
    });
    await store.linkMessage(receipt.receiptId, 81);
    expect(receipt.sourceMessageId).toBe(81);
    await store.linkTask(receipt.receiptId, 91, 17);
    await expect(store.linkTask(receipt.receiptId, 92, 17)).rejects.toMatchObject({
      code: "intent_receipt_task_conflict",
    });
    await expect(
      store.consumeForTask({ receiptId: receipt.receiptId, taskId: 91, projectId: 17 }),
    ).resolves.toMatchObject({
      consumedAt: "2026-08-21T00:00:01.000Z",
    });
    await expect(
      store.consumeForTask({ receiptId: receipt.receiptId, taskId: 91, projectId: 17 }),
    ).resolves.toMatchObject({
      consumedAt: "2026-08-21T00:00:01.000Z",
    });
    await expect(
      store.consumeForTask({ receiptId: receipt.receiptId, taskId: 92, projectId: 17 }),
    ).rejects.toMatchObject({
      code: "intent_receipt_task_conflict",
    });
    expect(driver.tasks).toEqual(new Map([[91, receipt.receiptId]]));
  });
});
