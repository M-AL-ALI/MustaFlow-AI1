import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  extractNamedFunction,
  extractTryStatementContainingIdentifier,
} from "./source-ast-test-helper";

const h = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  deductCreditsAtomic: vi.fn(),
  loggerInfo: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  pool: {
    query: h.poolQuery,
    connect: vi.fn(async () => ({
      query: h.clientQuery,
      release: vi.fn(),
    })),
  },
}));

vi.mock("./credits", () => ({
  deductCreditsAtomic: h.deductCreditsAtomic,
}));

vi.mock("./logger", () => ({
  logger: {
    info: h.loggerInfo,
    debug: h.loggerDebug,
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  processBillingSettlementRecord,
  settleCreditsDurably,
  startBillingSettlementSweeper,
  stopBillingSettlementSweeper,
  sweepBillingSettlements,
  type BillingSettlementRecord,
  type SettlementHandlers,
} from "./billing-settlement-outbox";

const creditInput = {
  ownerId: "owner-bw1",
  amount: 34,
  taskId: 901,
  opts: {
    type: "build" as const,
    description: "Build (eco) — project 77",
    projectId: 77,
    taskId: 901,
    source: "pipeline",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.poolQuery.mockResolvedValue({ rows: [] });
});

describe("durable billing settlement", () => {
  it("ships only additive, idempotent startup migration statements", () => {
    const source = readFileSync(new URL("./startup-migrations.ts", import.meta.url), "utf8");
    expect(source).toContain("migrate-bw1-money-path-durability");
    expect(source).toContain("ADD COLUMN IF NOT EXISTS status");
    expect(source).toContain("CREATE TABLE IF NOT EXISTS billing_settlement_outbox");
    expect(source).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_settlement_key_unique",
    );
    expect(source).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS nabuflow_usage_events_settlement_key_unique",
    );
  });

  it("wires overage failures to the outbox and exposes reconciliation", () => {
    const billing = readFileSync(new URL("./nabuflow-billing.ts", import.meta.url), "utf8");
    const admin = readFileSync(new URL("../routes/admin.ts", import.meta.url), "utf8");
    expect(billing).toContain('kind: "overage_invoice_item"');
    expect(billing).toContain("dedupeKey: `overage-stripe:${result.event.id}`");
    expect(admin).toContain("/admin/billing/settlement-reconciliation");
    expect(admin).toContain("usage.stripe_invoice_item_id IS NULL");
  });

  it("captures a rejected foreground deduction in the durable outbox", async () => {
    h.deductCreditsAtomic.mockRejectedValueOnce(new Error("database connection reset"));

    await expect(settleCreditsDurably(creditInput)).resolves.toEqual({ deferred: true });

    expect(h.poolQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO billing_settlement_outbox"),
      expect.arrayContaining([
        "credit_deduction",
        "task-credit:901:pipeline",
        901,
        "owner-bw1",
        34,
      ]),
    );
  });

  it("does not drain a deferred reservation into a canceled task", async () => {
    const record: BillingSettlementRecord = {
      id: 21,
      kind: "credit_deduction",
      dedupe_key: "task-credit:902:pipeline",
      task_id: 902,
      owner_id: "owner-bw1",
      amount: 13,
      context: { opts: creditInput.opts, reservation: true },
      attempts: 0,
    };
    h.poolQuery.mockResolvedValueOnce({ rows: [{ status: "canceled" }] });

    await processBillingSettlementRecord(record);

    expect(h.deductCreditsAtomic).not.toHaveBeenCalled();
  });

  it("records a successfully retried reservation on a live task", async () => {
    const record: BillingSettlementRecord = {
      id: 22,
      kind: "credit_deduction",
      dedupe_key: "task-credit:903:pipeline",
      task_id: 903,
      owner_id: "owner-bw1",
      amount: 13,
      context: { opts: creditInput.opts, reservation: true },
      attempts: 1,
    };
    h.poolQuery
      .mockResolvedValueOnce({ rows: [{ status: "queued" }] })
      .mockResolvedValueOnce({ rows: [] });
    h.deductCreditsAtomic.mockResolvedValueOnce({ newBalance: 1_587, charged: 13 });

    await processBillingSettlementRecord(record);

    expect(h.deductCreditsAtomic).toHaveBeenCalledWith(
      "owner-bw1",
      13,
      expect.objectContaining({ settlementKey: "task-credit:903:pipeline" }),
    );
    expect(h.poolQuery).toHaveBeenLastCalledWith(
      expect.stringContaining("SET credits_reserved = $2"),
      [903, 13],
    );
  });

  it("includes architect review and keys staged-review apply to the same pipeline settlement", () => {
    const jobs = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    const architectCharge = extractTryStatementContainingIdentifier(jobs, "dispatchResult");
    const stagedReviewCharge = extractNamedFunction(jobs, "applyTaskAgentStaging");

    expect(architectCharge).not.toContain("await settleCreditsDurably");
    expect(architectCharge).not.toContain("await deductCreditsAtomic");
    expect(stagedReviewCharge).toContain("await settleCreditsDurably");
    expect(stagedReviewCharge).toContain('source: "pipeline"');
    expect(stagedReviewCharge).not.toContain("void deductCreditsAtomic");
  });

  it("logs the settlement sweeper interval once when it starts", () => {
    vi.useFakeTimers();
    try {
      startBillingSettlementSweeper();
      expect(h.loggerInfo).toHaveBeenCalledWith(
        { intervalMs: 30_000 },
        "billing settlement sweeper started, interval 30s",
      );
    } finally {
      stopBillingSettlementSweeper();
      vi.useRealTimers();
    }
  });

  it("emits a debug heartbeat when a settlement sweep is empty", async () => {
    h.clientQuery.mockResolvedValue({ rows: [] });

    await expect(sweepBillingSettlements()).resolves.toEqual({
      completed: 0,
      deferred: 0,
    });
    expect(h.loggerDebug).toHaveBeenCalledWith({ claimed: 0 }, "billing settlement sweep empty");
  });

  it("recovers a queued settlement through the sweeper", async () => {
    const record: BillingSettlementRecord = {
      id: 12,
      kind: "credit_deduction",
      dedupe_key: "task-credit:901:pipeline",
      task_id: 901,
      owner_id: "owner-bw1",
      amount: 34,
      context: { opts: creditInput.opts },
      attempts: 1,
    };
    h.clientQuery.mockImplementation(async (query: string) => {
      if (query.includes("WITH due AS")) return { rows: [record] };
      return { rows: [] };
    });
    const handlers: SettlementHandlers = {
      creditDeduction: vi.fn(async () => undefined),
      overageInvoiceItem: vi.fn(async () => undefined),
      buildTokenTelemetry: vi.fn(async () => undefined),
    };

    await expect(sweepBillingSettlements(handlers)).resolves.toEqual({
      completed: 1,
      deferred: 0,
    });
    expect(handlers.creditDeduction).toHaveBeenCalledWith(record);
    expect(h.poolQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET completed_at = now()"),
      [12],
    );
  });

  it("keeps a failed retry pending with attempts and backoff", async () => {
    const record: BillingSettlementRecord = {
      id: 13,
      kind: "overage_invoice_item",
      dedupe_key: "overage-stripe:55",
      task_id: 902,
      owner_id: "owner-bw1",
      amount: 128,
      context: {},
      attempts: 2,
    };
    h.clientQuery.mockImplementation(async (query: string) => {
      if (query.includes("WITH due AS")) return { rows: [record] };
      return { rows: [] };
    });
    const handlers: SettlementHandlers = {
      creditDeduction: vi.fn(async () => undefined),
      overageInvoiceItem: vi.fn(async () => {
        throw new Error("Stripe timeout");
      }),
      buildTokenTelemetry: vi.fn(async () => undefined),
    };

    await expect(sweepBillingSettlements(handlers)).resolves.toEqual({
      completed: 0,
      deferred: 1,
    });
    expect(h.poolQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET attempts = $2"),
      expect.arrayContaining([13, 3, expect.any(Date), "Stripe timeout"]),
    );
  });
});
