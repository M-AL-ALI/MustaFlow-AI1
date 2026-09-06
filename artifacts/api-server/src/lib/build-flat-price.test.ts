import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const h = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  deductCreditsAtomic: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  pool: {
    query: h.poolQuery,
    connect: vi.fn(),
  },
}));

vi.mock("./credits", () => ({
  deductCreditsAtomic: h.deductCreditsAtomic,
}));

vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { settleCreditsDurably } from "./billing-settlement-outbox";

describe("build flat-price integrity", () => {
  it("settles a paid Lite build exactly once for 13 credits", async () => {
    const ledger: number[] = [];
    h.deductCreditsAtomic.mockImplementationOnce(async (_owner, amount, opts) => {
      ledger.push(amount);
      return { newBalance: 1_587, charged: amount, settlementKey: opts.settlementKey };
    });

    await expect(
      settleCreditsDurably({
        ownerId: "paid-lite-user",
        amount: 13,
        taskId: 4242,
        opts: {
          type: "build",
          description: "Build (lite) - project 91",
          projectId: 91,
          taskId: 4242,
          engineMode: "lite",
          deepReasoning: false,
          source: "pipeline",
        },
      }),
    ).resolves.toMatchObject({ charged: 13 });

    expect(ledger).toEqual([13]);
    expect(h.deductCreditsAtomic).toHaveBeenCalledWith(
      "paid-lite-user",
      13,
      expect.objectContaining({ settlementKey: "task-credit:4242:pipeline" }),
    );
  });

  it("does not add build-scoped architect, sense, creative, or subagent charges", () => {
    const jobs = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    const subagent = readFileSync(new URL("./subagent.ts", import.meta.url), "utf8");
    const imageJobs = readFileSync(new URL("./image-generation-jobs.ts", import.meta.url), "utf8");

    expect(jobs).not.toContain("ARCHITECT_CREDIT_COST");
    expect(jobs).not.toContain("onBillableSenseBatch:");
    expect(jobs).not.toContain("onBillableCreativeCall:");
    expect(subagent).not.toContain("ROLE_CREDIT_COST");
    expect(subagent).not.toContain("deductCreditsAtomic");

    // Image Studio remains a genuinely standalone, explicitly priced surface.
    expect(imageJobs).toContain("deductCreditsAtomic(userId, creditCost");
  });

  it("creates the background task before settling its pipeline reservation", () => {
    const messages = readFileSync(new URL("../routes/messages.ts", import.meta.url), "utf8");
    const taskInsert = messages.indexOf(".insert(agentTasksTable)");
    const backgroundSettlement = messages.indexOf("await settleCreditsDurably", taskInsert);

    expect(taskInsert).toBeGreaterThan(-1);
    expect(backgroundSettlement).toBeGreaterThan(taskInsert);
    expect(messages.slice(taskInsert, backgroundSettlement + 1_000)).toContain(
      'source: "pipeline"',
    );
    expect(messages.slice(taskInsert, backgroundSettlement + 1_000)).toContain("taskId: task.id");
  });
});
