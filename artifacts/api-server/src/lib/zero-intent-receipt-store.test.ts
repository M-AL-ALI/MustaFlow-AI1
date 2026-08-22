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

  async consumeForTask(receiptId: number, taskId: number) {
    const receipt = [...this.byKey.values()].find((candidate) => candidate.receiptId === receiptId);
    if (!receipt) throw new IntentReceiptError("intent_receipt_not_found");
    if (receipt.consumedAt) throw new IntentReceiptError("intent_receipt_already_consumed");
    receipt.consumedAt = "2026-08-21T00:00:01.000Z";
    this.tasks.set(taskId, receiptId);
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
    const receipt = await store.persist(17, "request-a", answer);
    await store.linkMessage(receipt.receiptId, 81);
    expect(receipt.sourceMessageId).toBe(81);
    await expect(store.consumeForTask(receipt.receiptId, 91)).resolves.toMatchObject({
      consumedAt: "2026-08-21T00:00:01.000Z",
    });
    await expect(store.consumeForTask(receipt.receiptId, 92)).rejects.toMatchObject({
      code: "intent_receipt_already_consumed",
    });
    expect(driver.tasks).toEqual(new Map([[91, receipt.receiptId]]));
  });
});
