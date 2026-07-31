import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  isSuperuser: vi.fn(),
  isBuilderAllowlistExempt: vi.fn(),
  recordZeroChargeUsage: vi.fn(),
  maybeChargeNabuflow: vi.fn(),
  selectWhere: vi.fn(),
  updateReturning: vi.fn(),
  insertValues: vi.fn(),
  transactionExistingRows: vi.fn(),
  transactionUpdateReturning: vi.fn(),
  transactionInsertValues: vi.fn(),
}));

vi.mock("express", () => ({
  Router: () => ({ get: vi.fn() }),
}));

vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => conditions,
  desc: (value: unknown) => value,
  eq: (left: unknown, right: unknown) => ({ left, right }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: mocks.selectWhere,
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: mocks.updateReturning,
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: mocks.insertValues,
    })),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: mocks.transactionExistingRows,
            })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: mocks.transactionUpdateReturning,
            })),
          })),
        })),
        insert: vi.fn(() => ({
          values: mocks.transactionInsertValues,
        })),
      }),
    ),
  },
  userCreditsTable: { userId: "user_id" },
  creditTransactionsTable: {
    userId: "user_id",
    createdAt: "created_at",
    settlementKey: "settlement_key",
    balanceAfter: "balance_after",
    amount: "amount",
  },
}));

vi.mock("../lib/emailClient", () => ({
  sendWelcomeEmail: vi.fn(),
  sendLowCreditEmail: vi.fn(),
}));

vi.mock("../lib/clerk-users", () => ({
  getClerkUserById: vi.fn(),
}));

vi.mock("../lib/superusers", () => ({
  isSuperuser: mocks.isSuperuser,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../lib/nabuflow-billing", () => ({
  isBuilderAllowlistExempt: mocks.isBuilderAllowlistExempt,
  recordZeroChargeUsage: mocks.recordZeroChargeUsage,
  maybeChargeNabuflow: mocks.maybeChargeNabuflow,
}));

const originalEnforcement = process.env.CREDITS_ENFORCEMENT;

async function loadDeduction(enforcementEnabled: boolean) {
  if (enforcementEnabled) {
    process.env.CREDITS_ENFORCEMENT = "true";
  } else {
    delete process.env.CREDITS_ENFORCEMENT;
  }
  vi.resetModules();
  return (await import("./credits")).deductCreditsAtomic;
}

function creditRow(balance = 50) {
  return {
    id: 1,
    userId: "owner-1",
    balance,
    updatedAt: new Date("2026-07-30T00:00:00.000Z"),
    lastLowCreditEmailAt: null,
  };
}

describe("deductCreditsAtomic actual charge reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isSuperuser.mockResolvedValue(false);
    mocks.isBuilderAllowlistExempt.mockResolvedValue(false);
    mocks.maybeChargeNabuflow.mockResolvedValue(null);
    mocks.selectWhere.mockResolvedValue([creditRow()]);
    mocks.updateReturning.mockResolvedValue([{ balance: 45 }]);
    mocks.insertValues.mockReturnValue({
      returning: vi.fn().mockResolvedValue([]),
    });
    mocks.transactionExistingRows.mockResolvedValue([]);
    mocks.transactionUpdateReturning.mockResolvedValue([{ balance: 45 }]);
    mocks.transactionInsertValues.mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (originalEnforcement === undefined) {
      delete process.env.CREDITS_ENFORCEMENT;
    } else {
      process.env.CREDITS_ENFORCEMENT = originalEnforcement;
    }
  });

  it("returns and records an actual charge of zero for an allowlist-exempt owner", async () => {
    mocks.isBuilderAllowlistExempt.mockResolvedValue(true);
    mocks.recordZeroChargeUsage.mockResolvedValue(undefined);
    const deductCreditsAtomic = await loadDeduction(true);

    await expect(
      deductCreditsAtomic("owner-1", 2, {
        type: "architect",
        description: "Architect review for task #175",
        projectId: 47,
        taskId: 175,
        engineMode: "power",
        deepReasoning: false,
        source: "architect",
        settlementKey: "task-credit:175:architect",
      }),
    ).resolves.toEqual({ newBalance: 50, charged: 0 });
    expect(mocks.updateReturning).not.toHaveBeenCalled();
    expect(mocks.recordZeroChargeUsage).toHaveBeenCalledWith("owner-1", {
      projectId: 47,
      taskId: 175,
      type: "architect",
      description: "Architect review for task #175",
      engineMode: "power",
      deepReasoning: false,
      source: "architect",
      settlementKey: "task-credit:175:architect",
    });
  });

  it("returns an actual charge of zero when enforcement is disabled", async () => {
    const deductCreditsAtomic = await loadDeduction(false);

    await expect(
      deductCreditsAtomic("owner-1", 5, {
        type: "build",
        description: "Power build",
      }),
    ).resolves.toEqual({ newBalance: 50, charged: 0 });
    expect(mocks.isBuilderAllowlistExempt).not.toHaveBeenCalled();
    expect(mocks.recordZeroChargeUsage).not.toHaveBeenCalled();
  });

  it("records one idempotent zero-value usage event for a retried superuser build", async () => {
    const usageRows = new Map<string, { userId: string; opts: Record<string, unknown> }>();
    mocks.isSuperuser.mockResolvedValue(true);
    mocks.recordZeroChargeUsage.mockImplementation(
      async (userId: string, opts: Record<string, unknown>) => {
        const settlementKey = opts.settlementKey;
        if (typeof settlementKey === "string" && !usageRows.has(settlementKey)) {
          usageRows.set(settlementKey, { userId, opts });
        }
      },
    );
    const deductCreditsAtomic = await loadDeduction(true);
    const opts = {
      type: "build" as const,
      description: "Lite build",
      projectId: 47,
      taskId: 177,
      engineMode: "lite",
      deepReasoning: false,
      source: "pipeline",
      settlementKey: "task-credit:177:pipeline",
    };

    await expect(deductCreditsAtomic("owner-1", 13, opts)).resolves.toEqual({
      newBalance: 50,
      charged: 0,
    });
    await expect(deductCreditsAtomic("owner-1", 13, opts)).resolves.toEqual({
      newBalance: 50,
      charged: 0,
    });

    expect(mocks.recordZeroChargeUsage).toHaveBeenCalledTimes(2);
    expect(usageRows).toEqual(
      new Map([
        [
          "task-credit:177:pipeline",
          {
            userId: "owner-1",
            opts,
          },
        ],
      ]),
    );
    expect(mocks.isBuilderAllowlistExempt).not.toHaveBeenCalled();
    expect(mocks.updateReturning).not.toHaveBeenCalled();
  });

  it("keeps a best-effort superuser ledger failure non-blocking without a settlement key", async () => {
    mocks.isSuperuser.mockResolvedValue(true);
    mocks.recordZeroChargeUsage.mockRejectedValueOnce(new Error("ledger unavailable"));
    const deductCreditsAtomic = await loadDeduction(true);

    await expect(
      deductCreditsAtomic("owner-1", 13, {
        type: "build",
        description: "Lite build",
      }),
    ).resolves.toEqual({ newBalance: 50, charged: 0 });
  });

  it("throws a superuser ledger failure when durable settlement can retry it", async () => {
    mocks.isSuperuser.mockResolvedValue(true);
    mocks.recordZeroChargeUsage.mockRejectedValueOnce(new Error("ledger unavailable"));
    const deductCreditsAtomic = await loadDeduction(true);

    await expect(
      deductCreditsAtomic("owner-1", 13, {
        type: "build",
        description: "Lite build",
        settlementKey: "task-credit:178:pipeline",
      }),
    ).rejects.toThrow("ledger unavailable");
  });

  it("returns the unchanged actual amount for a charged non-exempt owner", async () => {
    const deductCreditsAtomic = await loadDeduction(true);

    await expect(
      deductCreditsAtomic("owner-1", 5, {
        type: "build",
        description: "Power build",
      }),
    ).resolves.toEqual({ newBalance: 45, charged: 5 });
  });

  it("reports the requested amount when NabuFlow cycle accounting performs the charge", async () => {
    mocks.maybeChargeNabuflow.mockResolvedValue({ newBalance: 45 });
    const deductCreditsAtomic = await loadDeduction(true);

    await expect(
      deductCreditsAtomic("owner-1", 5, {
        type: "build",
        description: "Power build",
      }),
    ).resolves.toEqual({ newBalance: 45, charged: 5 });
    expect(mocks.updateReturning).not.toHaveBeenCalled();
  });

  it("deduplicates a durable wallet settlement without a second balance update", async () => {
    const deductCreditsAtomic = await loadDeduction(true);
    const opts = {
      type: "build" as const,
      description: "Eco build",
      settlementKey: "task-credit:901:pipeline",
    };

    await expect(deductCreditsAtomic("owner-1", 5, opts)).resolves.toEqual({
      newBalance: 45,
      charged: 5,
    });
    expect(mocks.transactionUpdateReturning).toHaveBeenCalledTimes(1);

    mocks.transactionExistingRows.mockResolvedValueOnce([{ balanceAfter: 45, amount: -5 }]);
    await expect(deductCreditsAtomic("owner-1", 5, opts)).resolves.toEqual({
      newBalance: 45,
      charged: 5,
    });
    expect(mocks.transactionUpdateReturning).toHaveBeenCalledTimes(1);
  });

  it("never wallet-fallbacks an ambiguous durable NabuFlow settlement", async () => {
    mocks.maybeChargeNabuflow.mockRejectedValueOnce(new Error("response lost after commit"));
    const deductCreditsAtomic = await loadDeduction(true);

    await expect(
      deductCreditsAtomic("owner-1", 5, {
        type: "build",
        description: "Eco build",
        settlementKey: "task-credit:902:pipeline",
      }),
    ).rejects.toThrow("response lost after commit");
    expect(mocks.transactionUpdateReturning).not.toHaveBeenCalled();
  });

  it("persists the deduction result instead of the architect price constant", () => {
    const jobsSource = readFileSync(new URL("../lib/jobs.ts", import.meta.url), "utf8");

    expect(jobsSource).toContain("creditsCharged = debit.charged");
    expect(jobsSource).not.toContain("creditsCharged = ARCHITECT_CREDIT_COST");
  });

  it("uses the returned actual charge at every audited recording/refund site", () => {
    const messagesSource = readFileSync(new URL("./messages.ts", import.meta.url), "utf8");
    const imageJobsSource = readFileSync(
      new URL("../lib/image-generation-jobs.ts", import.meta.url),
      "utf8",
    );
    const subagentSource = readFileSync(new URL("../lib/subagent.ts", import.meta.url), "utf8");

    expect(messagesSource).toContain("reservedCredits = deduct.charged");
    expect(imageJobsSource.match(/deduction\.charged > 0/g)).toHaveLength(2);
    expect(subagentSource).toContain("return { ok: true, charged: debit.charged }");
  });
});
