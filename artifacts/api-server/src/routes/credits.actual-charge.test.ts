import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  isSuperuser: vi.fn(),
  isBuilderAllowlistExempt: vi.fn(),
  maybeChargeNabuflow: vi.fn(),
  selectWhere: vi.fn(),
  updateReturning: vi.fn(),
  insertValues: vi.fn(),
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
  },
  userCreditsTable: { userId: "user_id" },
  creditTransactionsTable: { userId: "user_id", createdAt: "created_at" },
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
  });

  afterAll(() => {
    if (originalEnforcement === undefined) {
      delete process.env.CREDITS_ENFORCEMENT;
    } else {
      process.env.CREDITS_ENFORCEMENT = originalEnforcement;
    }
  });

  it("returns an actual charge of zero for an allowlist-exempt owner", async () => {
    mocks.isBuilderAllowlistExempt.mockResolvedValue(true);
    const deductCreditsAtomic = await loadDeduction(true);

    await expect(
      deductCreditsAtomic("owner-1", 2, {
        type: "architect",
        description: "Architect review for task #175",
      }),
    ).resolves.toEqual({ newBalance: 50, charged: 0 });
    expect(mocks.updateReturning).not.toHaveBeenCalled();
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
  });

  it("returns an actual charge of zero for a superuser", async () => {
    mocks.isSuperuser.mockResolvedValue(true);
    const deductCreditsAtomic = await loadDeduction(true);

    await expect(
      deductCreditsAtomic("owner-1", 5, {
        type: "build",
        description: "Power build",
      }),
    ).resolves.toEqual({ newBalance: 50, charged: 0 });
    expect(mocks.isBuilderAllowlistExempt).not.toHaveBeenCalled();
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
