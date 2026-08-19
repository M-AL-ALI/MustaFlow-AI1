import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

import { applyBrainstormAdmissionMigration } from "./startup-migrations";

describe("brainstorm admission startup migration", () => {
  it("is additive, idempotent, and emits a bounded cleanup receipt", async () => {
    const query = vi.fn(async (statement: string) => ({
      rows: [],
      rowCount: statement.includes("DELETE FROM brainstorm_admission_counters") ? 3 : 0,
    }));
    const client = { query } as never;

    await expect(applyBrainstormAdmissionMigration(client)).resolves.toEqual({
      tableReady: true,
      staleRowsRemoved: 3,
      retentionDaysAfterReset: 1,
    });
    await expect(applyBrainstormAdmissionMigration(client)).resolves.toEqual({
      tableReady: true,
      staleRowsRemoved: 3,
      retentionDaysAfterReset: 1,
    });

    const sql = query.mock.calls.map(([statement]) => String(statement)).join("\n");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS brainstorm_admission_counters");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS brainstorm_admission_counters_reset_idx");
    expect(sql).toContain("reset_at < transaction_timestamp() - interval '1 day'");
    expect(sql).not.toContain("DROP TABLE");
    expect(query).toHaveBeenCalledTimes(6);
  });
});
