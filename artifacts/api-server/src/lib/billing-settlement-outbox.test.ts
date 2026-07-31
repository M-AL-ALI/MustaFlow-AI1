import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const h = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  deductCreditsAtomic: vi.fn(),
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

vi.mock("../routes/credits", () => ({
  deductCreditsAtomic: h.deductCreditsAtomic,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  settleCreditsDurably,
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
