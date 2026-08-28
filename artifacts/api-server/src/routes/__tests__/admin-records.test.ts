import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("@workspace/db", () => ({ db: { execute: executeMock } }));
vi.mock("../../lib/adminAuth", () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../lib/logger", () => ({ logger: { error: vi.fn() } }));

import adminRecordsRouter, { maskAdminAccount } from "../admin-records";

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(adminRecordsRouter);
  return instance;
}

describe("Admin record drill-ins", () => {
  beforeEach(() => executeMock.mockReset());

  it("returns a bounded filterable project record without raw owner identity", async () => {
    executeMock.mockResolvedValue({
      rows: [
        {
          id: 52,
          name: "IRQ TEL",
          owner_id: "user_private_owner",
          workspace_id: 5,
          status: "published",
          kind: "web",
          stack: "node-api",
          published_snapshot_id: 158,
          public_slug: "irq-tel",
          updated_at: "2026-08-28T01:00:00.000Z",
          total_count: 1,
        },
      ],
    });

    const response = await request(app()).get("/admin/records/projects?limit=200&q=IRQ");

    expect(response.status).toBe(200);
    expect(response.body.page).toEqual({ limit: 50, offset: 0, total: 1, hasMore: false });
    expect(response.body.records[0]).toMatchObject({
      recordType: "project",
      id: 52,
      name: "IRQ TEL",
      ownerLabel: maskAdminAccount("user_private_owner"),
      publishedSnapshotId: 158,
    });
    expect(JSON.stringify(response.body)).not.toContain("user_private_owner");
  });

  it("opens masked account records with their useful activity counts", async () => {
    executeMock.mockResolvedValue({
      rows: [
        {
          credit_id: 8,
          user_id: "user_other_account",
          balance: 34,
          updated_at: "2026-08-28T02:00:00.000Z",
          project_count: 3,
          transaction_count: 9,
          total_count: 1,
        },
      ],
    });

    const response = await request(app()).get("/admin/records/credit-accounts");

    expect(response.status).toBe(200);
    expect(response.body.masking).toBe("account-identities-masked");
    expect(response.body.records[0]).toEqual({
      recordType: "credit-account",
      accountId: 8,
      accountLabel: maskAdminAccount("user_other_account"),
      balance: 34,
      projectCount: 3,
      transactionCount: 9,
      updatedAt: "2026-08-28T02:00:00.000Z",
    });
    expect(JSON.stringify(response.body)).not.toContain("user_other_account");
  });

  it("opens transaction detail without returning identity or receipt URL material", async () => {
    executeMock.mockResolvedValue({
      rows: [
        {
          id: 20,
          credit_id: 8,
          user_id: "user_other_account",
          project_id: 52,
          type: "build",
          amount: -2,
          description: "Trusted build",
          balance_after: 32,
          created_at: "2026-08-28T03:00:00.000Z",
          total_count: 1,
        },
      ],
    });

    const response = await request(app()).get("/admin/records/transactions");

    expect(response.status).toBe(200);
    expect(response.body.records[0]).toMatchObject({
      recordType: "transaction",
      id: 20,
      accountId: 8,
      accountLabel: maskAdminAccount("user_other_account"),
      projectId: 52,
      amount: -2,
      balanceAfter: 32,
    });
    expect(JSON.stringify(response.body)).not.toContain("user_other_account");
    expect(JSON.stringify(response.body)).not.toContain("receiptUrl");
  });

  it("refuses unknown views and overlong filters with typed plain responses", async () => {
    const missing = await request(app()).get("/admin/records/secrets");
    const tooLong = await request(app()).get(`/admin/records/projects?q=${"x".repeat(121)}`);

    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      error: "That Admin record view does not exist.",
      code: "admin_record_kind_not_found",
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body).toEqual({
      error: "Search text must be 120 characters or fewer.",
      code: "admin_record_search_too_long",
    });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("returns an honest unavailable terminal when the record store cannot be read", async () => {
    executeMock.mockResolvedValue({ rows: null });

    const response = await request(app()).get("/admin/records/projects");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: "Those Admin records are temporarily unavailable.",
      code: "admin_records_unavailable",
    });
    expect(JSON.stringify(response.body)).not.toContain("database detail");
  });
});
