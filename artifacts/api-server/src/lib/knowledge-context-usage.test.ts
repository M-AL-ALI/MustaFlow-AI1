import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: { transaction: vi.fn() },
  knowledgeEntriesTable: { id: "id", usageCount: "usage_count" },
}));

import {
  createKnowledgeContextUsageReceipt,
  recordKnowledgeContextUsage,
  type KnowledgeContextUsageMutationRunner,
} from "./knowledge-context-usage";

describe("explicit knowledge context usage mutation", () => {
  it("derives one canonical identity from sorted unique entry ids", () => {
    const left = createKnowledgeContextUsageReceipt({
      taskId: 12,
      projectId: 52,
      userId: "owner",
      entryIds: [9, 3, 9],
    });
    const right = createKnowledgeContextUsageReceipt({
      taskId: 12,
      projectId: 52,
      userId: "owner",
      entryIds: [3, 9],
    });
    expect(left).toEqual(right);
    expect(left.entryIds).toEqual([3, 9]);
    expect(left.identitySha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is idempotent for the same task/entry receipt", async () => {
    const recorded = new Set<string>();
    let mutationCount = 0;
    const runner: KnowledgeContextUsageMutationRunner = async (receipt) => {
      if (recorded.has(receipt.identitySha256)) return "exists";
      recorded.add(receipt.identitySha256);
      mutationCount++;
      return "recorded";
    };
    const input = { taskId: 12, projectId: 52, userId: "owner", entryIds: [3, 9] };

    await expect(recordKnowledgeContextUsage(input, runner)).resolves.toMatchObject({
      status: "recorded",
      entryCount: 2,
    });
    await expect(recordKnowledgeContextUsage(input, runner)).resolves.toMatchObject({
      status: "exists",
      entryCount: 2,
    });
    expect(mutationCount).toBe(1);
  });

  it("does not dispatch a mutation for an empty selection", async () => {
    const runner = vi.fn<KnowledgeContextUsageMutationRunner>();
    await expect(
      recordKnowledgeContextUsage(
        { taskId: 12, projectId: 52, userId: "owner", entryIds: [] },
        runner,
      ),
    ).resolves.toEqual({ ok: true, status: "skipped", identitySha256: null, entryCount: 0 });
    expect(runner).not.toHaveBeenCalled();
  });

  it("keeps retrieval free of usage-count writes", () => {
    const source = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    const start = source.indexOf("export async function loadKnowledgeContext(");
    const end = source.indexOf("async function loadLatestPlanSnapshot", start);
    const retrieval = source.slice(start, end);
    expect(retrieval).toContain("selectKnowledgeContext");
    expect(retrieval).not.toContain("usageCount:");
    expect(retrieval).not.toContain(".update(");
  });

  it("uses one durable advisory-locked receipt before incrementing", () => {
    const source = readFileSync(new URL("./knowledge-context-usage.ts", import.meta.url), "utf8");
    expect(source).toContain("pg_advisory_xact_lock");
    expect(source.indexOf("WHERE report_type")).toBeLessThan(
      source.indexOf(".update(knowledgeEntriesTable)"),
    );
    expect(source.indexOf(".update(knowledgeEntriesTable)")).toBeLessThan(
      source.indexOf("INSERT INTO knowledge_usage_events"),
    );
  });
});
