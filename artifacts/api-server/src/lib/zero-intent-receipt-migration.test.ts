import { describe, expect, it } from "vitest";
import { applyZeroIntentReceiptMigration } from "./startup-migrations";

function readyState() {
  return {
    table_ready: true,
    receipt_columns_ready: true,
    message_link_ready: true,
    task_link_ready: true,
    constraints_ready: true,
  };
}

describe("zero intent receipt startup migration", () => {
  it("is rerunnable, admission-indexed, and verifies resulting schema state", async () => {
    const runs: string[][] = [];
    const client = {
      query: async (statement: string) => {
        const normalized = statement.replace(/\s+/g, " ").trim();
        runs.at(-1)?.push(normalized);
        return normalized.startsWith("SELECT to_regclass")
          ? { rows: [readyState()], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      },
    } as unknown as Parameters<typeof applyZeroIntentReceiptMigration>[0];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      runs.push([]);
      await applyZeroIntentReceiptMigration(client);
    }
    expect(runs[1]).toEqual(runs[0]);
    const sql = runs[0].join("\n");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS zero_intent_receipts");
    expect(sql).toContain("consumed_at TIMESTAMPTZ");
    expect(sql).toContain("zero_intent_receipts_admission_idx");
    expect(sql).toContain("chat_messages_intent_receipt_fk");
    expect(sql).toContain("agent_tasks_intent_receipt_fk");
    expect(sql).not.toMatch(/UPDATE zero_intent_receipts SET/u);
    expect(runs[0].at(-1)).toBe("COMMIT");
  });

  it("rolls back when the catalog does not prove the final state", async () => {
    const statements: string[] = [];
    const client = {
      query: async (statement: string) => {
        const normalized = statement.replace(/\s+/g, " ").trim();
        statements.push(normalized);
        return normalized.startsWith("SELECT to_regclass")
          ? { rows: [{ ...readyState(), constraints_ready: false }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      },
    } as unknown as Parameters<typeof applyZeroIntentReceiptMigration>[0];
    await expect(applyZeroIntentReceiptMigration(client)).rejects.toThrow(
      "zero_intent_receipt_schema_incomplete",
    );
    expect(statements.at(-1)).toBe("ROLLBACK");
  });
});
