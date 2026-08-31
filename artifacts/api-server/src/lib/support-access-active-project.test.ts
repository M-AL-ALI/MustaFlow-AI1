import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  return {
    rows: [] as unknown[],
    select: vi.fn(),
    innerJoin: vi.fn(),
  };
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  mocks.select.mockImplementation(() => {
    const query = {
      from: vi.fn(),
      innerJoin: mocks.innerJoin,
      where: vi.fn(),
      orderBy: vi.fn(),
      limit: vi.fn(async () => mocks.rows),
    };
    query.from.mockReturnValue(query);
    mocks.innerJoin.mockReturnValue(query);
    query.where.mockReturnValue(query);
    query.orderBy.mockReturnValue(query);
    return query;
  });
  return { ...actual, db: { ...actual.db, select: mocks.select } };
});

vi.mock("./clerk-users", () => ({ getSharedAccountProfile: vi.fn() }));
vi.mock("./adminAuth", () => ({ resolveStaffPrincipal: vi.fn() }));

import { findLiveSupportGrant } from "./support-access";

const activeGrant = {
  id: 31,
  ticketId: 17,
  projectId: 51,
  ownerUserId: "owner",
  staffUserId: "staff",
  requestedBy: "staff",
  reason: "Investigate the reported preview failure",
  status: "active",
  requestedAt: new Date("2026-08-31T00:00:00.000Z"),
  decidedAt: new Date("2026-08-31T00:01:00.000Z"),
  expiresAt: new Date("2099-08-31T00:00:00.000Z"),
  revokedAt: null,
  closedAt: null,
};

describe("live support grant active-project binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows = [];
  });

  it("returns no live grant when the active-project join excludes a trashed project", async () => {
    await expect(
      findLiveSupportGrant({
        projectId: 51,
        staffUserId: "staff",
        now: new Date("2026-08-31T01:00:00.000Z"),
      }),
    ).resolves.toBeNull();

    expect(mocks.innerJoin).toHaveBeenCalledTimes(1);
    const source = readFileSync(new URL("./support-access.ts", import.meta.url), "utf8");
    expect(source).toContain(".innerJoin(");
    expect(source).toContain("isNull(projectsTable.deletedAt)");
  });

  it("returns the grant only when that active-project join yields it", async () => {
    mocks.rows = [activeGrant];

    await expect(
      findLiveSupportGrant({
        projectId: 51,
        staffUserId: "staff",
        now: new Date("2026-08-31T01:00:00.000Z"),
      }),
    ).resolves.toEqual(activeGrant);
  });
});
