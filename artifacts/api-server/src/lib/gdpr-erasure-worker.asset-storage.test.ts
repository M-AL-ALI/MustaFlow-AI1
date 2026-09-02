import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  databaseUrl: (process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"),
  select: vi.fn(),
  delete: vi.fn(),
  deleteWhere: vi.fn(async () => []),
  evictTierCache: vi.fn(),
}));

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...actual,
    db: { select: mocks.select, delete: mocks.delete },
  };
});
vi.mock("./logger", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("./public-ai/authed-user", () => ({ evictTierCache: mocks.evictTierCache }));

import { runGdprErasure } from "./gdpr-erasure-worker";

function directSelect(rows: unknown[], withLimit = false) {
  const where = vi.fn(() =>
    withLimit ? { limit: vi.fn(async () => rows) } : Promise.resolve(rows),
  );
  return { from: vi.fn(() => ({ where })) };
}

describe("GDPR account-only erasure boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.delete.mockImplementation(() => ({ where: mocks.deleteWhere }));
  });

  it("retries without deleting metadata when any governed project remains", async () => {
    mocks.select.mockImplementationOnce(() => directSelect([{ id: 51 }]));
    await expect(runGdprErasure("owner")).rejects.toThrow("gdpr_owned_projects_remain");
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("retries while account-scoped assets retain provider ownership evidence", async () => {
    mocks.select
      .mockImplementationOnce(() => directSelect([]))
      .mockImplementationOnce(() => directSelect([{ id: 71 }], true));
    await expect(runGdprErasure("owner")).rejects.toThrow("gdpr_account_assets_remain");
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("retries instead of erasing a live paid-storage receipt", async () => {
    mocks.select
      .mockImplementationOnce(() => directSelect([]))
      .mockImplementationOnce(() => directSelect([], true))
      .mockImplementationOnce(() => directSelect([{ status: "active" }]))
      .mockImplementationOnce(() => directSelect([]));
    await expect(runGdprErasure("owner")).rejects.toThrow("gdpr_active_billing_remains");
    expect(mocks.delete).not.toHaveBeenCalled();
  });
});
